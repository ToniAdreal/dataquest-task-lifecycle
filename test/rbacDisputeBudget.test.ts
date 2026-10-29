import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";
import type { RolePolicy } from "../src/taskLifecycle.js";

/**
 * DISPUTE rolePolicy x maxDisputes budget ordering (backlog #717).
 *
 * `dispatch()` checks gates in a fixed order: transition validity, then
 * the event-level RBAC policy, then the DISPUTE appeal budget (see
 * `src/taskLifecycle.ts`). The two DISPUTE gates therefore interact:
 * when both would fail, the caller must see the RBAC error, never the
 * budget error — and neither failed dispatch may consume budget, because
 * the used count is derived from the append-only history.
 *
 * The existing suites pin each gate alone (`rbac.test.ts` covers the
 * policy, `disputeBudget.test.ts` covers the budget, and it already
 * asserts the transition check precedes the budget check); this file
 * pins only their combination, which neither suite covered
 * (`grep maxDisputes test/rbac.test.ts` = 0).
 */

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** DISPUTE may only be raised by the moderator. */
const DISPUTE_POLICY: RolePolicy = { DISPUTE: ["moderator"] };

/** Drive a fresh task to REJECTED (first time or after a dispute round). */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

/** One full appeal round: REJECTED -> DISPUTED -> REJECTED. */
function disputeRound(task: TaskLifecycle): void {
  task.dispatch("DISPUTE", { actor: "moderator" }); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_REJECT"); // DISPUTED -> REJECTED (ungated)
}

/** How many DISPUTE entries the audit history holds. */
function disputeCount(task: TaskLifecycle): number {
  return task.history.filter((e) => e.event === "DISPUTE").length;
}

/** A task whose single appeal has been spent: 1 of 1 DISPUTEs used. */
function exhaustedTask(): TaskLifecycle {
  const task = new TaskLifecycle("rbac-budget-exhausted", {
    rolePolicy: DISPUTE_POLICY,
    maxDisputes: 1,
  });
  toRejected(task);
  disputeRound(task); // used 1 of 1
  assert.equal(task.state, "REJECTED");
  assert.equal(disputeCount(task), 1);
  return task;
}

describe("DISPUTE rolePolicy x maxDisputes ordering", () => {
  it("exhausted budget: an unauthorized actor still gets the RBAC error, not the budget error", () => {
    const task = exhaustedTask();
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE", { actor: "contributor" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          'actor not authorized for DISPUTE: "contributor" is not in [moderator]',
      "RBAC is checked before the budget, so the policy error must win",
    );
    // Failed dispatch leaves no trace and consumes no budget.
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before);
    assert.equal(disputeCount(task), 1);
  });

  it("exhausted budget: the authorized actor gets the budget error", () => {
    const task = exhaustedTask();
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE", { actor: "moderator" }),
      (err: unknown) =>
        err instanceof Error &&
        /^dispute budget exhausted: 1 of 1 DISPUTEs already used$/.test(
          err.message,
        ),
    );
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before);
    assert.equal(disputeCount(task), 1);
    // Retrying the failed budget dispatch still reports 1 of 1: the
    // rejection consumed nothing.
    assert.throws(
      () => task.dispatch("DISPUTE", { actor: "moderator" }),
      /dispute budget exhausted: 1 of 1 DISPUTEs already used/,
    );
    assert.equal(task.history.length, before);
  });

  it("exhausted budget: a missing actor also gets the RBAC error, not the budget error", () => {
    const task = exhaustedTask();
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "actor not authorized for DISPUTE: policy requires an actor in [moderator]",
      "the requires-actor branch of the policy check also precedes the budget",
    );
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before);
    assert.equal(disputeCount(task), 1);
  });

  it("budget not exhausted: an unauthorized DISPUTE is rejected and consumes nothing", () => {
    const task = new TaskLifecycle("rbac-budget-fresh", {
      rolePolicy: DISPUTE_POLICY,
      maxDisputes: 1,
    });
    toRejected(task);
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE", { actor: "contributor" }),
      /actor not authorized for DISPUTE: "contributor" is not in \[moderator\]/,
    );
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before);
    assert.equal(disputeCount(task), 0);
    // The rejected attempt left the single appeal intact.
    assert.equal(task.dispatch("DISPUTE", { actor: "moderator" }), "DISPUTED");
    assert.equal(disputeCount(task), 1);
  });

  it("ordering survives a toJSON/fromJSON round-trip: count from history, gates from snapshot", () => {
    const task = exhaustedTask();
    const restored = TaskLifecycle.fromJSON(task.toJSON());
    assert.equal(restored.state, "REJECTED");
    assert.equal(disputeCount(restored), 1);
    // Policy and budget both came back with the snapshot, and the
    // history-derived count still orders them the same way.
    assert.throws(
      () => restored.dispatch("DISPUTE", { actor: "contributor" }),
      /actor not authorized for DISPUTE: "contributor" is not in \[moderator\]/,
    );
    assert.throws(
      () => restored.dispatch("DISPUTE", { actor: "moderator" }),
      /dispute budget exhausted: 1 of 1 DISPUTEs already used/,
    );
    assert.equal(restored.history.length, task.history.length);
  });

  it("transition check still precedes both gates", () => {
    const task = new TaskLifecycle("rbac-budget-transition", {
      rolePolicy: DISPUTE_POLICY,
      maxDisputes: 0,
    });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    // In CAPTURING, DISPUTE is illegal: the transition error wins even
    // though the policy would also reject a contributor and the budget
    // is also exhausted.
    assert.throws(
      () => task.dispatch("DISPUTE", { actor: "contributor" }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "invalid transition: DISPUTE from CAPTURING",
    );
    assert.equal(task.state, "CAPTURING");
  });
});
