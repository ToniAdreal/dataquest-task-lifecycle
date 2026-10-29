import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * DISPUTE budget (maxDisputes) x payout-reference gate (requirePayoutRef).
 *
 * Each switch is covered on its own (disputeBudget.test.ts,
 * requirePayoutRef.test.ts), but no test combined them: a task that has
 * spent its one DISPUTE on a won appeal and then reaches payout must
 * still have its payout gate enforced, and a payout rejected by that
 * gate must not consume (or reset) the DISPUTE budget — the budget is
 * derived from the append-only history, so a rejected dispatch appends
 * nothing. This is the DISPUTE analogue of resubmitPayoutRef.test.ts
 * (#684), on a different budget dimension.
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
 * One won appeal round, then drive the task all the way to payout:
 * REJECTED -> DISPUTED -> APPROVED -> PAYOUT_PENDING.
 * (ARBITRATE_APPROVE is the won-appeal edge; the lost-appeal edge
 * ARBITRATE_REJECT loops back to REJECTED instead.)
 */
function disputeWonToPayoutPending(task: TaskLifecycle): void {
  task.dispatch("DISPUTE"); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_APPROVE"); // DISPUTED -> APPROVED
  task.dispatch("REQUEST_PAYOUT"); // APPROVED -> PAYOUT_PENDING
}

/** One lost appeal round: REJECTED -> DISPUTED -> REJECTED. */
function disputeLostRound(task: TaskLifecycle): void {
  task.dispatch("DISPUTE"); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_REJECT"); // DISPUTED -> REJECTED
}

function disputeCount(task: TaskLifecycle): number {
  return task.history.filter((e) => e.event === "DISPUTE").length;
}

const PAYOUT_REF_ERROR =
  "payout reference required: PAYOUT_COMPLETE must carry a non-empty payoutRef when requirePayoutRef is enabled";

describe("dispute budget x payoutRef gate", () => {
  it("after one won DISPUTE round, payout without a ref is rejected and the budget is untouched", () => {
    const task = new TaskLifecycle("dp-1", {
      maxDisputes: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    disputeWonToPayoutPending(task);
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(disputeCount(task), 1);

    const before = task.history.length;
    const lastSeq = task.history[before - 1].seq;
    assert.throws(
      () => task.dispatch("PAYOUT_COMPLETE"),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
      "payout without a ref must be rejected even after a won DISPUTE round",
    );
    // Failed dispatch leaves no trace: no history entry, no seq gap, and
    // the DISPUTE budget (derived from history) is unchanged.
    assert.equal(task.history.length, before);
    assert.equal(task.history[before - 1].seq, lastSeq);
    assert.equal(task.state, "PAYOUT_PENDING");
    assert.equal(disputeCount(task), 1);

    // The corrected payout still goes through.
    task.dispatch("PAYOUT_COMPLETE", { payoutRef: "xfer-dispute-1" });
    assert.equal(task.state, "PAID");
    assert.equal(task.history.length, before + 1);
    assert.equal(task.history[before].seq, lastSeq + 1);
    assert.equal(task.history[before].payoutRef, "xfer-dispute-1");
    assert.equal(disputeCount(task), 1);
  });

  it("a rejected payout consumes no idempotency key: retry with the same key and a ref passes", () => {
    const task = new TaskLifecycle("dp-2", {
      maxDisputes: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    disputeWonToPayoutPending(task);
    const before = task.history.length;
    assert.throws(
      () =>
        task.dispatch("PAYOUT_COMPLETE", { idempotencyKey: "k-pay-dispute" }),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
    );
    assert.equal(task.history.length, before);
    task.dispatch("PAYOUT_COMPLETE", {
      payoutRef: "xfer-dispute-2",
      idempotencyKey: "k-pay-dispute",
    });
    assert.equal(task.state, "PAID");
    assert.equal(task.history.length, before + 1);
    assert.equal(disputeCount(task), 1);
  });

  it("the budget is still exhausted after the DISPUTE round when the payout gate is also on", () => {
    const task = new TaskLifecycle("dp-3", {
      maxDisputes: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    disputeLostRound(task); // used 1 of 1, back at REJECTED
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "dispute budget exhausted: 1 of 1 DISPUTEs already used",
      "the payout gate must not reset the DISPUTE budget",
    );
    assert.equal(task.history.length, before);
    assert.equal(task.state, "REJECTED");
    assert.equal(disputeCount(task), 1);
  });

  it("control: the same won DISPUTE round without requirePayoutRef pays out without a ref", () => {
    const task = new TaskLifecycle("dp-4", { maxDisputes: 1 });
    toRejected(task);
    disputeWonToPayoutPending(task);
    assert.equal(disputeCount(task), 1);
    task.dispatch("PAYOUT_COMPLETE");
    assert.equal(task.state, "PAID");
  });

  it("fromHistory re-attaches both switches: budget derived from the log, gate enforced at payout", () => {
    const task = new TaskLifecycle("dp-5", {
      maxDisputes: 1,
      requirePayoutRef: true,
    });
    toRejected(task);
    disputeWonToPayoutPending(task);
    const log = JSON.parse(JSON.stringify(task.history));

    const revived = TaskLifecycle.fromHistory("dp-5", log, {
      maxDisputes: 1,
      requirePayoutRef: true,
    });
    assert.equal(revived.state, "PAYOUT_PENDING");
    assert.equal(disputeCount(revived), 1);
    const before = revived.history.length;
    assert.throws(
      () => revived.dispatch("PAYOUT_COMPLETE"),
      (err: unknown) => err instanceof Error && err.message === PAYOUT_REF_ERROR,
    );
    assert.equal(revived.history.length, before);
    assert.equal(disputeCount(revived), 1);
    revived.dispatch("PAYOUT_COMPLETE", { payoutRef: "xfer-dispute-5" });
    assert.equal(revived.state, "PAID");
  });
});
