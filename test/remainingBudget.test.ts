import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * Budget-remaining read-only API (backlog #1127).
 *
 * Backlog #1115 exposed the used counts (`resubmitCount` /
 * `disputeCount` / `visitCount(state)`); a caller that wanted to
 * answer "how many RESUBMITs are left" still had to compute
 * `max - used` itself and hand-roll the Infinity / unconfigured
 * sentinel branches. The `remainingResubmits` / `remainingDisputes`
 * getters and `remainingVisits(state)` delegate to the same private
 * history-derived counts the dispatch-time budget checks read, so the
 * remaining numbers can never drift from the audit trail or from the
 * budget-exhausted error text: 0 here means the next dispatch of
 * that kind is rejected.
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

describe("budget remaining read-only API", () => {
  it("fresh task: remaining equals the configured budget, Infinity when unconfigured", () => {
    const budgeted = new TaskLifecycle("t1", {
      maxResubmits: 2,
      maxDisputes: 1,
    });
    assert.equal(budgeted.remainingResubmits, 2);
    assert.equal(budgeted.remainingDisputes, 1);
    const unbudgeted = new TaskLifecycle("t2");
    assert.equal(unbudgeted.remainingResubmits, Infinity);
    assert.equal(unbudgeted.remainingDisputes, Infinity);
    assert.equal(unbudgeted.remainingVisits("CAPTURING"), Infinity);
    assert.equal(unbudgeted.remainingVisits("DRAFT"), Infinity);
  });

  it("remainingResubmits steps down with each RESUBMIT and is 0 at exhaustion", () => {
    const task = new TaskLifecycle("t3", { maxResubmits: 2 });
    toRejected(task);
    assert.equal(task.remainingResubmits, 2);
    resubmitRound(task);
    assert.equal(task.remainingResubmits, 1);
    resubmitRound(task);
    assert.equal(task.remainingResubmits, 0);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^resubmit budget exhausted: 2 of 2 RESUBMITs already used$/.test(
          err.message,
        ),
      "0 remaining must mean the next RESUBMIT is rejected, with matching numbers",
    );
    // A rejected dispatch leaves the remaining count at 0, never negative.
    assert.equal(task.remainingResubmits, 0);
  });

  it("remainingDisputes steps down with each DISPUTE and is 0 at exhaustion", () => {
    const task = new TaskLifecycle("t4", { maxDisputes: 1 });
    toRejected(task);
    assert.equal(task.remainingDisputes, 1);
    disputeRound(task);
    assert.equal(task.remainingDisputes, 0);
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        /^dispute budget exhausted: 1 of 1 DISPUTEs already used$/.test(
          err.message,
        ),
      "0 remaining must mean the next DISPUTE is rejected, with matching numbers",
    );
    assert.equal(task.remainingDisputes, 0);
  });

  it("remaining stays Infinity without a budget even as usage steps", () => {
    const task = new TaskLifecycle("t5");
    toRejected(task);
    resubmitRound(task);
    resubmitRound(task);
    disputeRound(task);
    assert.equal(task.resubmitCount, 2);
    assert.equal(task.disputeCount, 1);
    assert.equal(task.remainingResubmits, Infinity);
    assert.equal(task.remainingDisputes, Infinity);
  });

  it("a 0 resubmit budget reads 0 from the start and rejects immediately", () => {
    const task = new TaskLifecycle("t6", { maxResubmits: 0 });
    assert.equal(task.remainingResubmits, 0);
    toRejected(task);
    assert.equal(task.remainingResubmits, 0);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      /resubmit budget exhausted: 0 of 0 RESUBMITs already used/,
    );
  });

  it("remainingVisits steps down per state and is 0 exactly at the visit-budget blocking point", () => {
    const task = new TaskLifecycle("t7", { maxVisitsByState: { CAPTURING: 2 } });
    assert.equal(task.remainingVisits("CAPTURING"), 2);
    toRejected(task);
    assert.equal(task.remainingVisits("CAPTURING"), 1);
    resubmitRound(task);
    assert.equal(task.remainingVisits("CAPTURING"), 0);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^state visit budget exhausted: CAPTURING already visited 2 of 2 times$/.test(
          err.message,
        ),
      "the visit budget blocks exactly when the readable remaining hits 0",
    );
    assert.equal(task.remainingVisits("CAPTURING"), 0);
  });

  it("remainingVisits of an unbudgeted state is Infinity even after visits", () => {
    const task = new TaskLifecycle("t8", { maxVisitsByState: { CAPTURING: 2 } });
    toRejected(task);
    resubmitRound(task);
    assert.equal(task.visitCount("REJECTED"), 2);
    assert.equal(task.remainingVisits("REJECTED"), Infinity);
    assert.equal(task.remainingVisits("PAID"), Infinity);
  });

  it("a budget of 1 for an already-passed state is already spent (initial visit counts)", () => {
    const task = new TaskLifecycle("t9", { maxVisitsByState: { DRAFT: 1 } });
    assert.equal(task.visitCount("DRAFT"), 1);
    assert.equal(task.remainingVisits("DRAFT"), 0);
    // The same holds for a state reached mid-life: budget 1 for
    // REJECTED is spent the moment the task first lands there.
    const task2 = new TaskLifecycle("t10", {
      maxVisitsByState: { REJECTED: 1 },
    });
    assert.equal(task2.remainingVisits("REJECTED"), 1);
    toRejected(task2);
    assert.equal(task2.remainingVisits("REJECTED"), 0);
  });

  it("remainingVisits throws on an unknown state, like visitCount does", () => {
    const task = new TaskLifecycle("t11");
    assert.throws(
      () => task.remainingVisits("OPNE" as never),
      (err: unknown) =>
        err instanceof Error &&
        /^invalid remaining visits: unknown state OPNE$/.test(err.message),
      "a misspelled state is a caller bug, not an infinite budget",
    );
  });

  it("remaining values survive a toJSON/fromJSON round-trip (history-derived, never reset)", () => {
    const task = new TaskLifecycle("t12", {
      maxResubmits: 2,
      maxDisputes: 1,
      maxVisitsByState: { CAPTURING: 3 },
    });
    toRejected(task);
    resubmitRound(task);
    disputeRound(task);
    const restored = TaskLifecycle.fromJSON(task.toJSON());
    assert.equal(restored.remainingResubmits, 1);
    assert.equal(restored.remainingDisputes, 0);
    assert.equal(restored.remainingVisits("CAPTURING"), 1);
    assert.equal(restored.remainingVisits("REJECTED"), Infinity);
    // The budget itself survives too: one more RESUBMIT is allowed, then it is spent.
    resubmitRound(restored);
    assert.equal(restored.remainingResubmits, 0);
    assert.equal(restored.remainingVisits("CAPTURING"), 0);
    assert.throws(
      () => restored.dispatch("RESUBMIT"),
      /resubmit budget exhausted: 2 of 2/,
    );
  });

  it("remaining values survive a fromHistory rebuild", () => {
    const task = new TaskLifecycle("t13", {
      maxResubmits: 2,
      maxVisitsByState: { CAPTURING: 3 },
    });
    toRejected(task);
    resubmitRound(task);
    const rebuilt = TaskLifecycle.fromHistory("t13-copy", task.history, {
      maxResubmits: 2,
      maxVisitsByState: { CAPTURING: 3 },
    });
    assert.equal(rebuilt.remainingResubmits, 1);
    assert.equal(rebuilt.remainingVisits("CAPTURING"), 1);
    assert.equal(rebuilt.remainingVisits("REJECTED"), Infinity);
    assert.equal(rebuilt.state, "REJECTED");
  });

  it("reading the remaining values is pure: state and history do not move", () => {
    const task = new TaskLifecycle("t14", {
      maxResubmits: 2,
      maxVisitsByState: { CAPTURING: 2 },
    });
    toRejected(task);
    resubmitRound(task);
    const before = task.toJSON();
    assert.equal(task.remainingResubmits, 1);
    assert.equal(task.remainingDisputes, Infinity);
    assert.equal(task.remainingVisits("CAPTURING"), 0);
    assert.equal(task.remainingVisits("REJECTED"), Infinity);
    assert.deepEqual(task.toJSON(), before);
    assert.equal(task.state, "REJECTED");
  });
});
