import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * Budget-usage read-only API (backlog #1115).
 *
 * The three budgets' used counts used to live only in private
 * history-derived getters (`_resubmitCount`, `_disputeCount`,
 * `_stateVisitCount`): a caller could only learn the used number by
 * waiting for the budget-exhausted error text. The public
 * `resubmitCount` / `disputeCount` getters and `visitCount(state)`
 * expose the same history-derived counts, so a watchdog or dashboard
 * can read usage before dispatching.
 */

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** Drive a fresh task to REJECTED (first time or after a resubmit loop). */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

const BACK_TO_REJECTED: Array<"SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** One RESUBMIT round: from REJECTED back to REJECTED. */
function resubmitRound(task: TaskLifecycle): void {
  task.dispatch("RESUBMIT"); // REJECTED -> CAPTURING
  for (const event of BACK_TO_REJECTED) task.dispatch(event);
}

/** One DISPUTE round: REJECTED -> DISPUTED -> REJECTED (appeal rejected). */
function disputeRound(task: TaskLifecycle): void {
  task.dispatch("DISPUTE"); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_REJECT"); // DISPUTED -> REJECTED
}

describe("budget usage read-only API", () => {
  it("fresh task: resubmit/dispute counts are 0, initial state visited once, unvisited states 0", () => {
    const task = new TaskLifecycle("t1");
    assert.equal(task.resubmitCount, 0);
    assert.equal(task.disputeCount, 0);
    assert.equal(task.visitCount("DRAFT"), 1);
    assert.equal(task.visitCount("OPEN"), 0);
    assert.equal(task.visitCount("PAID"), 0);
    assert.equal(task.visitCount("REJECTED"), 0);
  });

  it("resubmitCount steps with each RESUBMIT and matches the exhausted error's number", () => {
    const task = new TaskLifecycle("t2", { maxResubmits: 2 });
    toRejected(task);
    assert.equal(task.resubmitCount, 0);
    resubmitRound(task);
    assert.equal(task.resubmitCount, 1);
    resubmitRound(task);
    assert.equal(task.resubmitCount, 2);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^resubmit budget exhausted: 2 of 2 RESUBMITs already used$/.test(
          err.message,
        ),
      "error text must name the same used count the getter reports",
    );
    // A failed dispatch leaves the count untouched.
    assert.equal(task.resubmitCount, 2);
  });

  it("disputeCount steps with each DISPUTE and matches the exhausted error's number", () => {
    const task = new TaskLifecycle("t3", { maxDisputes: 1 });
    toRejected(task);
    assert.equal(task.disputeCount, 0);
    disputeRound(task);
    assert.equal(task.disputeCount, 1);
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        /^dispute budget exhausted: 1 of 1 DISPUTEs already used$/.test(
          err.message,
        ),
      "error text must name the same used count the getter reports",
    );
    assert.equal(task.disputeCount, 1);
  });

  it("counts still step when no budget is configured (unlimited is not uncounted)", () => {
    const task = new TaskLifecycle("t4");
    toRejected(task);
    resubmitRound(task);
    resubmitRound(task);
    disputeRound(task);
    assert.equal(task.resubmitCount, 2);
    assert.equal(task.disputeCount, 1);
    assert.equal(task.visitCount("CAPTURING"), 3);
  });

  it("visitCount tracks entries per state, including re-entries", () => {
    const task = new TaskLifecycle("t5");
    assert.equal(task.visitCount("DRAFT"), 1);
    toRejected(task);
    assert.equal(task.visitCount("DRAFT"), 1);
    assert.equal(task.visitCount("OPEN"), 1);
    assert.equal(task.visitCount("CAPTURING"), 1);
    assert.equal(task.visitCount("REJECTED"), 1);
    resubmitRound(task);
    assert.equal(task.visitCount("CAPTURING"), 2);
    assert.equal(task.visitCount("REJECTED"), 2);
    assert.equal(task.visitCount("SUBMITTED"), 2);
  });

  it("visitCount of a terminal state counts 1 once the task lands there", () => {
    const task = new TaskLifecycle("t6");
    for (const event of [
      "PUBLISH",
      "ACCEPT",
      "START_CAPTURE",
      "SUBMIT",
      "BEGIN_REVIEW",
      "APPROVE",
      "REQUEST_PAYOUT",
      "PAYOUT_COMPLETE",
    ] as const) {
      task.dispatch(event);
    }
    assert.equal(task.state, "PAID");
    assert.equal(task.visitCount("PAID"), 1);
    assert.equal(task.visitCount("PAYOUT_PENDING"), 1);
  });

  it("visitCount throws on an unknown state, like setSlaDeadline does", () => {
    const task = new TaskLifecycle("t7");
    assert.throws(
      () => task.visitCount("OPNE" as never),
      (err: unknown) =>
        err instanceof Error &&
        /^invalid visit count: unknown state OPNE$/.test(err.message),
      "a misspelled state is a caller bug, not a zero count",
    );
  });

  it("counts survive a toJSON/fromJSON round-trip (history-derived, never reset)", () => {
    const task = new TaskLifecycle("t8", { maxResubmits: 2, maxDisputes: 1 });
    toRejected(task);
    resubmitRound(task);
    disputeRound(task);
    const restored = TaskLifecycle.fromJSON(task.toJSON());
    assert.equal(restored.resubmitCount, 1);
    assert.equal(restored.disputeCount, 1);
    assert.equal(restored.visitCount("CAPTURING"), 2);
    assert.equal(restored.visitCount("DISPUTED"), 1);
    // REJECTED: toRejected (1) + resubmit round (1) + dispute round's ARBITRATE_REJECT (1).
    assert.equal(restored.visitCount("REJECTED"), 3);
    // The budget itself survives too: one more RESUBMIT is allowed, then it is spent.
    resubmitRound(restored);
    assert.equal(restored.resubmitCount, 2);
    assert.throws(
      () => restored.dispatch("RESUBMIT"),
      /resubmit budget exhausted: 2 of 2/,
    );
  });

  it("counts survive a fromHistory rebuild", () => {
    const task = new TaskLifecycle("t9");
    toRejected(task);
    resubmitRound(task);
    disputeRound(task);
    const rebuilt = TaskLifecycle.fromHistory("t9-copy", task.history);
    assert.equal(rebuilt.resubmitCount, 1);
    assert.equal(rebuilt.disputeCount, 1);
    assert.equal(rebuilt.visitCount("CAPTURING"), 2);
    assert.equal(rebuilt.visitCount("DISPUTED"), 1);
    assert.equal(rebuilt.state, "REJECTED");
  });

  it("reading the counts is pure: state and history do not move", () => {
    const task = new TaskLifecycle("t10");
    toRejected(task);
    resubmitRound(task);
    const before = task.toJSON();
    assert.equal(task.resubmitCount, 1);
    assert.equal(task.disputeCount, 0);
    assert.equal(task.visitCount("CAPTURING"), 2);
    assert.equal(task.visitCount("REJECTED"), 2);
    assert.deepEqual(task.toJSON(), before);
    assert.equal(task.state, "REJECTED");
  });

  it("visitCount agrees with the per-state visit budget's blocking point", () => {
    const task = new TaskLifecycle("t11", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task);
    assert.equal(task.visitCount("CAPTURING"), 1);
    resubmitRound(task);
    assert.equal(task.visitCount("CAPTURING"), 2);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^state visit budget exhausted: CAPTURING already visited 2 of 2 times$/.test(
          err.message,
        ),
      "the visit budget blocks exactly when the readable count reaches the cap",
    );
    assert.equal(task.visitCount("CAPTURING"), 2);
  });

  it("counts are stable across repeated reads and independent of budget config", () => {
    const budgeted = new TaskLifecycle("t12", { maxResubmits: 5 });
    const unbudgeted = new TaskLifecycle("t13");
    for (const t of [budgeted, unbudgeted]) {
      toRejected(t);
      resubmitRound(t);
    }
    assert.equal(budgeted.resubmitCount, unbudgeted.resubmitCount);
    assert.equal(budgeted.resubmitCount, 1);
    assert.equal(budgeted.resubmitCount, budgeted.resubmitCount);
  });
});
