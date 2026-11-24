/**
 * `isOverdue` rejects a non-`TaskLifecycle` task with a named error
 * (backlog #1371).
 *
 * The single-task read path was the last hole the batch guard
 * (#1342) did not cover: `expiredTasks` / `expireOverdueTasks` /
 * `tasksByFilters` all screen through `assertTaskInstanceBatch`
 * before they ever reach `isOverdue`, but a direct `isOverdue(null)`
 * died as a bare `TypeError` reading `getSlaDeadline`. The guard is
 * `instanceof`, not a shape scan — `isOverdue` calls the
 * `getSlaDeadline()` method, which only a real task guarantees, so
 * a #893-style plain-object stand-in would pass a shape check and
 * still die at the method call (the same trade-off the batch guard
 * documents). The guard runs before the `now` check, matching the
 * batch selectors' order, so a malformed task is never masked by a
 * bad clock value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, isOverdue } from "../src/index.js";

const DEADLINE = "2026-03-02T09:00:00.000Z";
const AFTER = new Date("2026-03-05T09:00:00.000Z");
const AT_DEADLINE = new Date(DEADLINE);
const BEFORE = new Date("2026-03-01T09:00:00.000Z");
// Fixture audit timestamps: pinned before every screening instant, so
// the screening `now` never trips the non-decreasing-timestamp check.
const PUBLISH_AT = "2026-03-01T09:00:00.000Z";
const EXPIRE_AT = "2026-03-01T10:00:00.000Z";

/** OPEN task with an SLA deadline on its current state. */
function openTask(id: string, deadline: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  t.setSlaDeadline(deadline);
  return t;
}

/** OPEN task with no SLA deadline for its current state. */
function openTaskNoDeadline(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  return t;
}

/** Terminal (EXPIRED) task whose deadline is in the past. */
function terminalTask(id: string): TaskLifecycle {
  const t = openTask(id, DEADLINE);
  t.dispatch("EXPIRE", { actor: "system", at: EXPIRE_AT });
  return t;
}

describe("isOverdue rejects a non-TaskLifecycle task (#1371)", () => {
  it("null throws a named error, never a bare TypeError", () => {
    assert.throws(
      () => isOverdue(null as never),
      /invalid isOverdue: task must be a TaskLifecycle, got null/,
    );
  });

  it("string / number / undefined / boolean / array inputs throw the named error", () => {
    for (const bad of ["x", 42, undefined, true, []]) {
      assert.throws(
        () => isOverdue(bad as never),
        /invalid isOverdue: task must be a TaskLifecycle, got (string|number|undefined|boolean|object)/,
        `task=${JSON.stringify(bad)}`,
      );
    }
  });

  it("a shape-only stand-in is rejected: the guard is instanceof, not a shape scan", () => {
    // A #893-style plain object with the exact properties isOverdue
    // reads — state, isTerminal, getSlaDeadline — still has no
    // TaskLifecycle prototype, so the guard must reject it instead
    // of letting it through to die at the method call.
    const standIn = {
      id: "stand-in",
      state: "OPEN",
      isTerminal: false,
      getSlaDeadline: () => DEADLINE,
    };
    assert.throws(
      () => isOverdue(standIn as never),
      /invalid isOverdue: task must be a TaskLifecycle, got object/,
    );
  });

  it("the task guard runs before the now check", () => {
    // Both inputs are bad; the caller must see the task error, not
    // the clock error — same order as the batch selectors (#1342).
    assert.throws(
      () => isOverdue(null as never, new Date(Number.NaN)),
      /invalid isOverdue: task must be a TaskLifecycle, got null/,
    );
    assert.throws(
      () => isOverdue("x" as never, "not-a-date" as never),
      /invalid isOverdue: task must be a TaskLifecycle, got string/,
    );
  });

  it("a valid task with an invalid now still throws invalid now", () => {
    // The new guard must not swallow the #1334 clock check: a real
    // task passes the instanceof gate and reaches the now check.
    const task = openTask("valid-task-bad-now", DEADLINE);
    assert.throws(
      () => isOverdue(task, new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => isOverdue(task, "2026-03-05" as never),
      /invalid now: expected a valid Date/,
    );
  });
});

describe("isOverdue legal-task behaviour is unchanged (#1371)", () => {
  it("overdue / not yet due / boundary", () => {
    const overdue = openTask("legal-overdue", DEADLINE);
    const notOverdue = openTask("legal-not-overdue", "2026-03-10T09:00:00.000Z");
    assert.equal(isOverdue(overdue, AFTER), true);
    assert.equal(isOverdue(overdue, BEFORE), false);
    assert.equal(isOverdue(notOverdue, AFTER), false);
    // Boundary is inclusive: now == deadline counts as overdue.
    assert.equal(isOverdue(overdue, AT_DEADLINE), true);
  });

  it("terminal and no-deadline tasks still answer false", () => {
    const terminal = terminalTask("legal-terminal");
    const noDeadline = openTaskNoDeadline("legal-no-deadline");
    assert.equal(isOverdue(terminal, AFTER), false);
    assert.equal(isOverdue(noDeadline, AFTER), false);
  });

  it("a task restored from history is a real instance and still works", () => {
    const original = openTask("legal-restored", DEADLINE);
    // The log carries no deadlines, so they re-attach through the
    // opts — without them the restored task has no deadline and
    // answers false, which is also a real-instance answer (no throw).
    const restored = TaskLifecycle.fromHistory(
      original.id,
      JSON.parse(JSON.stringify(original.history)),
      { slaDeadlines: { OPEN: DEADLINE } },
    );
    assert.equal(isOverdue(restored, AFTER), true);
    assert.equal(isOverdue(restored, BEFORE), false);
    const noDeadline = TaskLifecycle.fromHistory(
      original.id,
      JSON.parse(JSON.stringify(original.history)),
    );
    assert.equal(isOverdue(noDeadline, AFTER), false);
  });
});
