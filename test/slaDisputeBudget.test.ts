import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expiredTasks,
  expireOverdueTasks,
  isOverdue,
} from "../src/index.js";

/**
 * SLA overdue x DISPUTE budget combination (backlog #683).
 *
 * The two mechanisms are orthogonal by design, and this file pins that
 * down from both sides:
 *
 * - A budget that is already exhausted never blocks EXPIRE: the budget
 *   check gates only dispatch("DISPUTE"), never any other event.
 * - Being overdue never waives the budget: an overdue task that already
 *   spent its DISPUTEs still gets the budget error, not a free appeal.
 *
 * One wrinkle the backlog text glosses over: a task that just spent
 * its DISPUTE sits in DISPUTED or, after arbitration rejects the
 * appeal, back in REJECTED — and neither state has an EXPIRE edge
 * (EXPIRE exists only on OPEN/ACCEPTED/CAPTURING/SUBMITTED). So the
 * "EXPIRE succeeds despite an exhausted budget" leg must run on a
 * task that burned its DISPUTE budget and then RESUBMITs into
 * CAPTURING — the state a RESUBMIT lands in — while the REJECTED leg
 * covers the budget-refusal side. The watchdog batch test covers both
 * states together, including the per-task error shape for the
 * unexpirable one. This mirrors backlog #676 (SLA x RESUBMIT budget)
 * with the budget dimension swapped to DISPUTE.
 */

const PAST = new Date("2020-01-01T00:00:00.000Z");
const NOW = new Date("2026-10-04T00:00:00.000Z");

const TO_REJECTED: Array<
  "PUBLISH" | "ACCEPT" | "START_CAPTURE" | "SUBMIT" | "BEGIN_REVIEW" | "REJECT"
> = ["PUBLISH", "ACCEPT", "START_CAPTURE", "SUBMIT", "BEGIN_REVIEW", "REJECT"];

/** Fixed audit timestamps for driven chains: strictly increasing, all before NOW. */
const DRIVE_AT = [
  "2026-01-01T00:00:00.000Z", // PUBLISH
  "2026-02-01T00:00:00.000Z", // ACCEPT
  "2026-02-15T00:00:00.000Z", // START_CAPTURE
  "2026-03-01T00:00:00.000Z", // SUBMIT
  "2026-03-15T00:00:00.000Z", // BEGIN_REVIEW
  "2026-04-01T00:00:00.000Z", // REJECT
  "2026-05-01T00:00:00.000Z", // DISPUTE
  "2026-06-01T00:00:00.000Z", // ARBITRATE_REJECT
  "2026-07-01T00:00:00.000Z", // RESUBMIT
  "2026-08-01T00:00:00.000Z", // SUBMIT (second round)
  "2026-08-15T00:00:00.000Z", // BEGIN_REVIEW (second round)
  "2026-09-01T00:00:00.000Z", // REJECT (second round)
] as const;

/** Drive a fresh task to REJECTED. */
function toRejected(task: TaskLifecycle): void {
  for (const [i, event] of TO_REJECTED.entries()) {
    task.dispatch(event, { at: DRIVE_AT[i] });
  }
}

/** One full appeal round: REJECTED -> DISPUTED -> REJECTED (arbitration rejects the appeal). */
function disputeRound(task: TaskLifecycle): void {
  task.dispatch("DISPUTE", { at: DRIVE_AT[6] }); // REJECTED -> DISPUTED
  task.dispatch("ARBITRATE_REJECT", { at: DRIVE_AT[7] }); // DISPUTED -> REJECTED
}

/**
 * Budget 1, spent: drive to REJECTED, DISPUTE once, and RESUBMIT into
 * CAPTURING — the state the RESUBMIT lands in, where EXPIRE is legal.
 */
function exhaustedInCapturing(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id, { maxDisputes: 1 });
  toRejected(task);
  disputeRound(task); // used 1 of 1 -> back in REJECTED
  task.dispatch("RESUBMIT", { at: DRIVE_AT[8] }); // REJECTED -> CAPTURING
  assert.equal(task.state, "CAPTURING");
  return task;
}

/**
 * Budget 1, spent: drive to REJECTED and DISPUTE once, staying in
 * REJECTED — the state where a second DISPUTE is budget-refused.
 */
function exhaustedInRejected(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id, { maxDisputes: 1 });
  toRejected(task);
  disputeRound(task); // used 1 of 1
  assert.equal(task.state, "REJECTED");
  return task;
}

describe("SLA overdue x DISPUTE budget", () => {
  it("exhausted budget does not block EXPIRE on an overdue CAPTURING task", () => {
    const task = exhaustedInCapturing("sla-dispute-1");
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
      task.history.filter((e) => e.event === "DISPUTE").length,
      1,
    );
  });

  it("overdue status does not waive the budget on a REJECTED task", () => {
    const task = exhaustedInRejected("sla-dispute-2");
    task.setSlaDeadline(PAST); // deadline for REJECTED, already past
    assert.equal(isOverdue(task, NOW), true);

    const before = task.history.length;
    assert.throws(
      () => task.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error &&
        /^dispute budget exhausted: 1 of 1 DISPUTEs already used$/.test(err.message),
      "overdue must not grant a free DISPUTE past the budget",
    );
    assert.equal(task.state, "REJECTED");
    assert.equal(task.history.length, before, "failed dispatch leaves no trace");
  });

  it("budget 0 never gates EXPIRE either: a never-disputed overdue task expires", () => {
    const task = new TaskLifecycle("sla-dispute-3", { maxDisputes: 0 });
    task.dispatch("PUBLISH");
    task.dispatch("ACCEPT");
    task.dispatch("START_CAPTURE"); // CAPTURING, zero DISPUTEs used
    task.setSlaDeadline(PAST);
    assert.equal(isOverdue(task, NOW), true);
    task.dispatch("EXPIRE", { actor: "system" });
    assert.equal(task.state, "EXPIRED");
  });

  it("expiredTasks screening is budget-blind: both overdue tasks are listed", () => {
    const capturing = exhaustedInCapturing("sla-dispute-4a");
    capturing.setSlaDeadline(PAST);
    const rejected = exhaustedInRejected("sla-dispute-4b");
    rejected.setSlaDeadline(PAST);
    const fresh = new TaskLifecycle("sla-dispute-4c", { maxDisputes: 1 });
    fresh.dispatch("PUBLISH");
    fresh.setSlaDeadline(new Date("2099-01-01T00:00:00.000Z")); // not overdue

    const overdue = expiredTasks([capturing, rejected, fresh], NOW);
    assert.deepEqual(
      overdue.map((t) => t.id),
      ["sla-dispute-4a", "sla-dispute-4b"],
      "screening follows the deadline only, never the budget",
    );
  });

  it("watchdog batch: one expires, the unexpirable one reports a transition error, never a budget error", () => {
    const capturing = exhaustedInCapturing("sla-dispute-5a");
    capturing.setSlaDeadline(PAST);
    const rejected = exhaustedInRejected("sla-dispute-5b");
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
    const capturing = exhaustedInCapturing("sla-dispute-6a");
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
    const rejected = exhaustedInRejected("sla-dispute-6b");
    rejected.setSlaDeadline(PAST);
    const restoredRejected = TaskLifecycle.fromJSON(
      JSON.parse(JSON.stringify(rejected.toJSON())),
    );
    assert.equal(restoredRejected.state, "REJECTED");
    assert.equal(restoredRejected.getSlaDeadline(), PAST.toISOString());
    assert.equal(isOverdue(restoredRejected, NOW), true);
    assert.throws(
      () => restoredRejected.dispatch("DISPUTE"),
      (err: unknown) =>
        err instanceof Error && err.message.startsWith("dispute budget exhausted: 1 of 1"),
      "budget must not reset across the round-trip, even when overdue",
    );
  });
});
