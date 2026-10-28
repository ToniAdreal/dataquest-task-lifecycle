import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expiredTasks,
  expireOverdueTasks,
  isOverdue,
} from "../src/index.js";

/**
 * SLA overdue x RESUBMIT budget combination (backlog #676).
 *
 * The two mechanisms are orthogonal by design, and this file pins that
 * down from both sides:
 *
 * - A budget that is already exhausted never blocks EXPIRE: the budget
 *   check gates only dispatch("RESUBMIT"), never any other event.
 * - Being overdue never waives the budget: an overdue task that already
 *   spent its RESUBMITs still gets the budget error, not a free retry.
 *
 * One wrinkle the backlog text glosses over: REJECTED has no EXPIRE
 * edge (EXPIRE exists only on OPEN/ACCEPTED/CAPTURING/SUBMITTED), so
 * the "EXPIRE succeeds despite an exhausted budget" leg must run on a
 * task that burned its budget and then sits in CAPTURING — the state a
 * RESUBMIT itself lands in — while the REJECTED leg covers the
 * budget-refusal side. The watchdog batch test covers both states
 * together, including the per-task error shape for the unexpirable one.
 */

const PAST = new Date("2020-01-01T00:00:00.000Z");
const NOW = new Date("2026-10-04T00:00:00.000Z");

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** Drive a fresh task to REJECTED. */
function toRejected(task: TaskLifecycle): void {
  for (const event of TO_REJECTED) task.dispatch(event);
}

/**
 * Budget 1, spent: drive to REJECTED, RESUBMIT once, and stop in
 * CAPTURING — the state the RESUBMIT lands in, where EXPIRE is legal.
 */
function exhaustedInCapturing(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id, { maxResubmits: 1 });
  toRejected(task);
  task.dispatch("RESUBMIT"); // used 1 of 1 -> CAPTURING
  assert.equal(task.state, "CAPTURING");
  return task;
}

/**
 * Budget 1, spent: drive to REJECTED, RESUBMIT once, and loop back to
 * REJECTED — the state where a second RESUBMIT is budget-refused.
 */
function exhaustedInRejected(id: string): TaskLifecycle {
  const task = exhaustedInCapturing(id);
  for (const event of ["SUBMIT", "BEGIN_REVIEW", "REJECT"] as const) {
    task.dispatch(event);
  }
  assert.equal(task.state, "REJECTED");
  return task;
}

describe("SLA overdue x RESUBMIT budget", () => {
  it("exhausted budget does not block EXPIRE on an overdue CAPTURING task", () => {
    const task = exhaustedInCapturing("sla-resubmit-1");
    task.setSlaDeadline(PAST); // deadline for CAPTURING, already past
    assert.equal(isOverdue(task, NOW), true);

    task.dispatch("EXPIRE", { actor: "system" });
    assert.equal(task.state, "EXPIRED");
    const last = task.history[task.history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.from, "CAPTURING");
    assert.equal(last.to, "EXPIRED");
    // The budget count is history-derived and untouched by EXPIRE.
    assert.equal(
      task.history.filter((e) => e.event === "RESUBMIT").length,
      1,
    );
  });

  it("overdue status does not waive the budget on a REJECTED task", () => {
    const task = exhaustedInRejected("sla-resubmit-2");
    task.setSlaDeadline(PAST); // deadline for REJECTED, already past
    assert.equal(isOverdue(task, NOW), true);

    const before = task.history.length;
    assert.throws(
      () => task.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error &&
        /^resubmit budget exhausted: 1 of 1 RESUBMITs already used$/.test(err.message),
      "overdue must not grant a free RESUBMIT past the budget",
    );
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before, "failed dispatch leaves no trace");
  });

  it("budget 0 never gates EXPIRE either: a never-resubmitted overdue task expires", () => {
    const task = new TaskLifecycle("sla-resubmit-3", { maxResubmits: 0 });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE"); // CAPTURING, zero RESUBMITs used
    task.setSlaDeadline(PAST);
    assert.equal(isOverdue(task, NOW), true);
    task.dispatch("EXPIRE", { actor: "system" });
    assert.equal(task.state, "EXPIRED");
  });

  it("expiredTasks screening is budget-blind: both overdue tasks are listed", () => {
    const capturing = exhaustedInCapturing("sla-resubmit-4a");
    capturing.setSlaDeadline(PAST);
    const rejected = exhaustedInRejected("sla-resubmit-4b");
    rejected.setSlaDeadline(PAST);
    const fresh = new TaskLifecycle("sla-resubmit-4c", { maxResubmits: 1 });
    fresh.dispatch("PUBLISH");
    fresh.setSlaDeadline(new Date("2099-01-01T00:00:00.000Z")); // not overdue

    const overdue = expiredTasks([capturing, rejected, fresh], NOW);
    assert.deepEqual(
      overdue.map((t) => t.id),
      ["sla-resubmit-4a", "sla-resubmit-4b"],
      "screening follows the deadline only, never the budget",
    );
  });

  it("watchdog batch: one expires, the unexpirable one reports a transition error, never a budget error", () => {
    const capturing = exhaustedInCapturing("sla-resubmit-5a");
    capturing.setSlaDeadline(PAST);
    const rejected = exhaustedInRejected("sla-resubmit-5b");
    rejected.setSlaDeadline(PAST);

    const results = expireOverdueTasks([capturing, rejected], NOW);
    assert.equal(results.length, 2);

    assert.equal(results[0].expired, true);
    assert.equal(results[0].task.state, "EXPIRED");
    assert.equal(results[0].entry?.event, "EXPIRE");
    assert.equal(results[0].entry?.to, "EXPIRED");

    // REJECTED has no EXPIRE edge: the watchdog must report that
    // transition failure per task and keep going — and the failure must
    // be about the missing edge, not the exhausted budget.
    assert.equal(results[1].expired, false);
    assert.equal(results[1].error, "invalid transition: EXPIRE from REJECTED");
    assert.equal(results[1].entry, undefined);
    assert.equal(results[1].task.state, "REJECTED");
  });

  it("snapshot round-trip preserves the combination on both sides", () => {
    // CAPTURING side: restored task is still overdue and still expirable.
    const capturing = exhaustedInCapturing("sla-resubmit-6a");
    capturing.setSlaDeadline(PAST);
    const restoredCapturing = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(capturing.toJSON())),
    );
    assert.equal(restoredCapturing.state, "CAPTURING");
    assert.equal(restoredCapturing.getSlaDeadline(), PAST.toISOString());
    assert.equal(isOverdue(restoredCapturing, NOW), true);
    restoredCapturing.dispatch("EXPIRE", { actor: "system" });
    assert.equal(restoredCapturing.state, "EXPIRED");

    // REJECTED side: restored task is still overdue and still budget-blocked.
    const rejected = exhaustedInRejected("sla-resubmit-6b");
    rejected.setSlaDeadline(PAST);
    const restoredRejected = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(rejected.toJSON())),
    );
    assert.equal(restoredRejected.state, "REJECTED");
    assert.equal(restoredRejected.getSlaDeadline(), PAST.toISOString());
    assert.equal(isOverdue(restoredRejected, NOW), true);
    assert.throws(
      () => restoredRejected.dispatch("RESUBMIT"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("resubmit budget exhausted: 1 of 1"),
      "budget must not reset across the round-trip, even when overdue",
    );
  });
});
