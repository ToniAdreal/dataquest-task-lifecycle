import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/taskLifecycle.js";

/**
 * RESUBMIT retry budget (TaskLifecycleOptions.maxResubmits).
 *
 * The budget caps how many RESUBMIT dispatches a task may run. The used
 * count is derived from the append-only history, so it survives
 * toJSON()/fromJSON() round-trips together with the budget itself.
 */

const TO_REJECTED: Array<"PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "PUBLISH",
  "ACCEPT",
  "START_CAPTURE",
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** Drive a fresh task to REJECTED (first time or after a resubmit loop). */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

const RESUBMIT_BACK_TO_REJECTED: Array<"SUBMIT" | "BEGIN_REVIEW" | "REJECT"> = [
  "SUBMIT",
  "BEGIN_REVIEW",
  "REJECT",
];

/** One RESUBMIT round: from REJECTED back to REJECTED. */
function resubmitRound(task: TaskLifecycle): void {
  task.dispatch("RESUBMIT"); // REJECTED -> CAPTURING
  for (const event of RESUBMIT_BACK_TO_REJECTED) task.dispatch(event);
}

describe("resubmit budget", () => {
  it("budget 2: first two RESUBMITs pass, the third throws resubmit budget exhausted", () => {
    const task = new TaskLifecycle("t1", { maxResubmits: 2 });
    toRejected(task);
    resubmitRound(task); // used 1 of 2
    resubmitRound(task); // used 2 of 2, back at REJECTED
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^resubmit budget exhausted: 2 of 2 RESUBMITs already used$/.test(err.message),
      "third RESUBMIT must throw the explicit budget error",
    );
    // Failed dispatch leaves no trace: history still ends at REJECTED.
    assert.equal(task.state, "REJECTED");
  });

  it("budget 0: the very first RESUBMIT throws", () => {
    const task = new TaskLifecycle("t2", { maxResubmits: 0 });
    toRejected(task);
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted: 0 of 0"),
    );
  });

  it("default (no opts): unlimited RESUBMITs, pre-budget behavior unchanged", () => {
    const task = new TaskLifecycle("t3");
    toRejected(task);
    for (let i = 0; i < 5; i++) resubmitRound(task);
    assert.equal(task.state, "REJECTED");
    // explicitly passing undefined keeps the same behavior
    const task2 = new TaskLifecycle("t4", {});
    toRejected(task2);
    for (let i = 0; i < 5; i++) resubmitRound(task2);
    assert.equal(task2.state, "REJECTED");
  });

  it("explicit Infinity budget behaves like the default", () => {
    const task = new TaskLifecycle("t5", { maxResubmits: Infinity });
    toRejected(task);
    for (let i = 0; i < 5; i++) resubmitRound(task);
    assert.equal(task.state, "REJECTED");
    assert.equal("maxResubmits" in task.toJSON(), false); // Infinity is not stored
  });

  it("budget applies only to RESUBMIT: other events never hit the budget", () => {
    const task = new TaskLifecycle("t6", { maxResubmits: 0 });
    // A task that never goes through REJECTED works normally.
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE");
    assert.equal(task.state, "CAPTURING");
  });

  it("rejected dispatch leaves no gap: after a failed RESUBMIT, later legal events keep appending", () => {
    const task = new TaskLifecycle("t7", { maxResubmits: 0 });
    toRejected(task);
    const before = task.history.length;
    assert.throws(() => task.dispatch("RESUBMIT"));
    assert.equal(task.history.length, before);
    task.dispatch("DISPUTE"); // legal event still appends cleanly
    assert.equal(task.history.length, before + 1);
    assert.equal(task.history[before].seq, before + 1);
  });

  it("transition check runs before the budget check", () => {
    const task = new TaskLifecycle("t8", { maxResubmits: 0 });
    // In DRAFT, RESUBMIT is an illegal event: the transition error wins,
    // even though the budget is also exhausted.
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message === "invalid transition: RESUBMIT from DRAFT",
    );
  });

  it("constructor rejects invalid budgets", () => {
    for (const bad of [-1, 1.5, Number.NaN, "2" as unknown as number, null as unknown as number]) {
      assert.throws(
        () => new TaskLifecycle("bad", { maxResubmits: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid option: maxResubmits must be a non-negative integer or Infinity"),
        `maxResubmits=${String(bad)} must throw`,
      );
    }
  });

  it("snapshot round-trip preserves budget AND used count (no reset)", () => {
    const task = new TaskLifecycle("t9", { maxResubmits: 2 });
    toRejected(task);
    resubmitRound(task); // used 1 of 2
    const json = JSON.parse(JSON.stringify(task)) as {
      maxResubmits?: number;
      history: Array<{ event: string }>;
    };
    assert.equal(json.maxResubmits, 2);
    assert.equal(json.history.filter((e) => e.event === "RESUBMIT").length, 1);

    const restored = TaskLifecycle.fromJSON(json);
    assert.equal(restored.state, "REJECTED");
    restored.dispatch("RESUBMIT"); // 2nd allowed, used 2 of 2 -> CAPTURING
    for (const event of ["SUBMIT", "BEGIN_REVIEW", "REJECT"] as const) {
      restored.dispatch(event); // back to REJECTED
    }
    assert.throws(
      () => restored.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted: 2 of 2"),
      "budget must not reset after a round-trip",
    );
  });

  it("unbudgeted task snapshots carry no maxResubmits field and rehydrate unlimited", () => {
    const task = new TaskLifecycle("t10");
    toRejected(task);
    resubmitRound(task);
    const snap = task.toJSON();
    assert.equal("maxResubmits" in snap, false);
    const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.state, "REJECTED");
    resubmitRound(restored);
    resubmitRound(restored); // still unlimited after the round-trip
  });

  it("fromJSON rejects malformed maxResubmits envelopes", () => {
    const base = { id: "t11", state: "DRAFT", history: [], slaDeadlines: {} };
    for (const bad of [-1, 1.5, Number.NaN, "2", null]) {
      assert.throws(
        () => TaskLifecycle.fromJSON({ ...base, maxResubmits: bad }),
        (err: unknown) =>
          err instanceof Error &&
          err.message.startsWith("invalid snapshot: maxResubmits must be"),
        `maxResubmits=${String(bad)} must be rejected`,
      );
    }
  });

  it("fromJSON accepts a snapshot whose history already exceeds its budget (policy for the future, not history truth)", () => {
    const task = new TaskLifecycle("t12", { maxResubmits: 2 });
    toRejected(task);
    resubmitRound(task);
    resubmitRound(task); // used 2 of 2
    const snap = task.toJSON();
    // Hand-edit the envelope down to a stricter budget: a truthful record.
    const strict = TaskLifecycle.fromJSON({ ...snap, maxResubmits: 1 });
    assert.equal(strict.state, "REJECTED");
    assert.throws(
      () => strict.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted: 2 of 1"),
    );
  });

  it("fromHistory re-attaches a budget; used count derives from the replayed log", () => {
    const task = new TaskLifecycle("t13", { maxResubmits: 1 });
    toRejected(task);
    resubmitRound(task); // used 1 of 1
    const log = JSON.parse(JSON.stringify(task.history));

    const revived = TaskLifecycle.fromHistory("t13", log, { maxResubmits: 1 });
    assert.equal(revived.state, "REJECTED");
    assert.throws(
      () => revived.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted: 1 of 1"),
    );

    // Without opts, the same log rehydrates with no budget.
    const free = TaskLifecycle.fromHistory("t13", log);
    resubmitRound(free);
    assert.equal(free.state, "REJECTED");
  });
});
