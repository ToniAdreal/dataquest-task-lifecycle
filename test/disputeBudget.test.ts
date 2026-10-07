import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * DISPUTE appeal budget (TaskLifecycleOptions.maxDisputes).
 *
 * The transition table lets REJECTED -> DISPUTED -> ARBITRATE_REJECT ->
 * REJECTED loop without limit; the appeal budget caps how many DISPUTE
 * dispatches a task may run. Like maxResubmits, the used count is
 * derived from the append-only history, so it survives toJSON()/fromJSON()
 * round-trips together with the budget itself.
 */

const TO_REJECTED: Array<"PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** Drive a fresh task to REJECTED (first time or after a dispute round). */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

/** One full appeal round: REJECTED -> DISPUTED -> REJECTED (arbitration rejects the appeal). */
function disputeRound(task: TaskLifecycle): void {
  task.dispatch("DISPUTE"); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_REJECT"); // DISPUTED -> REJECTED
}

describe("dispute budget", () => {
  it("budget 1: the first DISPUTE passes, the second throws dispute budget exhausted", () => {
    const task = new TaskLifecycle("t1", { maxDisputes: 1 });
    toRejected(task);
    disputeRound(task); // used 1 of 1
    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        /^dispute budget exhausted: 1 of 1 DISPUTEs already used$/.test(err.message),
      "second DISPUTE must throw the explicit budget error",
    );
    // Failed dispatch leaves no trace: still REJECTED, history untouched.
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before);
  });

  it("budget 0: the very first DISPUTE throws", () => {
    const task = new TaskLifecycle("t2", { maxDisputes: 0 });
    toRejected(task);
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted: 0 of 0"),
    );
  });

  it("default (no opts) and explicit Infinity: unlimited DISPUTEs, pre-budget behavior unchanged", () => {
    const task = new TaskLifecycle("t3");
    toRejected(task);
    for (let i = 0; i < 3; i++) disputeRound(task);
    assert.equal(task.state, "REJECTED");
    assert.equal(
      task.history.filter((e) => e.event === "DISPUTE").length,
      3,
    );

    const task2 = new TaskLifecycle("t4", { maxDisputes: Infinity });
    toRejected(task2);
    for (let i = 0; i < 3; i++) disputeRound(task2);
    assert.equal(task2.state, "REJECTED");
    assert.equal("maxDisputes" in task2.toJSON(), false); // Infinity is not stored
  });

  it("budget applies only to DISPUTE: arbitration and other events never hit the budget", () => {
    // Even with maxDisputes=0, a task that never disputes works normally.
    const task = new TaskLifecycle("t5", { maxDisputes: 0 });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    assert.equal(task.state, "CAPTURING");

    // ARBITRATE_APPROVE is not a DISPUTE dispatch: one appeal budget of 1
    // lets the appeal be won, and the task keeps flowing afterwards.
    const task2 = new TaskLifecycle("t6", { maxDisputes: 1 });
    toRejected(task2);
    task2.dispatch("DISPUTE"); // used 1 of 1
    task2.dispatch("ARBITRATE_APPROVE"); // DISPUTED -> APPROVED (not a DISPUTE)
    task2.dispatch("REQUEST_PAYOUT");
    assert.equal(task2.state, "PAYOUT_PENDING");
  });

  it("rejected dispatch leaves no gap: after a failed DISPUTE, later legal events keep appending", () => {
    const task = new TaskLifecycle("t7", { maxDisputes: 0 });
    toRejected(task);
    const before = task.history.length;
    assert.throws(() => task.dispatch("DISPUTE"));
    assert.equal(task.history.length, before);
    task.dispatch("RESUBMIT"); // legal event still appends cleanly
    assert.equal(task.history.length, before + 1);
    assert.equal(task.history[before].seq, before + 1);
  });

  it("transition check runs before the budget check", () => {
    const task = new TaskLifecycle("t8", { maxDisputes: 0 });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    // In CAPTURING, DISPUTE is an illegal event: the transition error wins,
    // even though the budget is also exhausted.
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message === "invalid transition: DISPUTE from CAPTURING",
    );
  });

  it("constructor rejects invalid budgets", () => {
    for (const bad of [-1, 1.5, Number.NaN, "2" as unknown as number, null as unknown as number]) {
      assert.throws(
        () => new TaskLifecycle("bad", { maxDisputes: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid option: maxDisputes must be a non-negative integer or Infinity"),
        `maxDisputes=${String(bad)} must throw`,
      );
    }
  });

  it("snapshot round-trip preserves budget AND used count (no reset)", () => {
    const task = new TaskLifecycle("t9", { maxDisputes: 2 });
    toRejected(task);
    disputeRound(task); // used 1 of 2
    const json = JSON.parse(JSON.stringify(task)) as {
      maxDisputes?: number;
      history: Array<{ event: string }>;
    };
    assert.equal(json.maxDisputes, 2);
    assert.equal(json.history.filter((e) => e.event === "DISPUTE").length, 1);

    const restored = TaskLifecycle.fromJSON(json);
    assert.equal(restored.state, "REJECTED");
    disputeRound(restored); // 2nd allowed, used 2 of 2 -> back at REJECTED
    assert.throws(
      () => restored.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted: 2 of 2"),
      "budget must not reset after a round-trip",
    );
  });

  it("unbudgeted task snapshots carry no maxDisputes field and rehydrate unlimited", () => {
    const task = new TaskLifecycle("t10");
    toRejected(task);
    disputeRound(task);
    const snap = task.toJSON();
    assert.equal("maxDisputes" in snap, false);
    const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.state, "REJECTED");
    disputeRound(restored);
    disputeRound(restored); // still unlimited after the round-trip
  });

  it("fromJSON rejects malformed maxDisputes envelopes", () => {
    const base = { id: "t11", state: "DRAFT", history: [], slaDeadlines: {} };
    for (const bad of [-1, 1.5, Number.NaN, "2", null]) {
      assert.throws(
        () => TaskLifecycle.fromJSON({ ...base, maxDisputes: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid snapshot: maxDisputes must be"),
        `maxDisputes=${String(bad)} must be rejected`,
      );
    }
  });

  it("fromJSON accepts a snapshot whose history already exceeds its budget (policy for the future, not history truth)", () => {
    const task = new TaskLifecycle("t12", { maxDisputes: 2 });
    toRejected(task);
    disputeRound(task);
    disputeRound(task); // used 2 of 2
    const snap = task.toJSON();
    // Hand-edit the envelope down to a stricter budget: a truthful record.
    const strict = TaskLifecycle.fromJSON({ ...snap, maxDisputes: 1 });
    assert.equal(strict.state, "REJECTED");
    assert.throws(
      () => strict.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted: 2 of 1"),
    );
  });

  it("fromHistory re-attaches a budget; used count derives from the replayed log", () => {
    const task = new TaskLifecycle("t13", { maxDisputes: 1 });
    toRejected(task);
    disputeRound(task); // used 1 of 1
    const log = JSON.parse(JSON.stringify(task.history));

    const revived = TaskLifecycle.fromHistory("t13", log, { maxDisputes: 1 });
    assert.equal(revived.state, "REJECTED");
    assert.throws(
      () => revived.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted: 1 of 1"),
    );

    // Without opts, the same log rehydrates with no budget.
    const free = TaskLifecycle.fromHistory("t13", log);
    disputeRound(free);
    assert.equal(free.state, "REJECTED");
  });

  it("resubmit budget and dispute budget are independent on the same task", () => {
    const task = new TaskLifecycle("t14", { maxResubmits: 1, maxDisputes: 1 });
    toRejected(task);
    task.dispatch("RESUBMIT"); // used 1 of 1 resubmits
    for (const event of ["SUBMIT", "BEGIN_REVIEW", "REJECT"] as const) {
      task.dispatch(event);
    }
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted"),
    );
    // A RESUBMIT-exhausted task can still run its appeal round.
    disputeRound(task);
    assert.equal(task.state, "REJECTED");
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted"),
    );
  });
});
