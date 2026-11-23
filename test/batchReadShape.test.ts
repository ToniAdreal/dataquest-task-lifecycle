/**
 * Batch-selector shape guards (backlog #1342).
 *
 * `unreconciledPayouts()` / `expiredTasks()` / `tasksByFilters()` used
 * to validate only their secondary parameters, never the batch itself:
 * a `null` batch died as a bare `TypeError` (`reading 'filter'`), a
 * `[null]` batch died reading `state` (or `getSlaDeadline`, inside
 * `isOverdue`), and — worst — `tasksByFilters([null], {})` silently
 * returned `[null]` when no filter axis was set, handing the caller a
 * `null` to use as a task. Two guards, by what each selector reads:
 * `expiredTasks()` and `tasksByFilters()` use `instanceof
 * TaskLifecycle` (escrow's `assertEscrowBatch`, backlog #1340) — they
 * read `isTerminal` and `getSlaDeadline()`, which only a real task
 * guarantees. `unreconciledPayouts()` uses the shape guard
 * (`assertTaskBatch`, backlog #1341): it reads only `state` and
 * `history`, and the #893 defensive stand-in — a PAID task with no
 * `PAYOUT_COMPLETE` entry at all — flows through it and
 * `payoutAging()`, so a shape-only stand-in must keep passing there.
 *
 * Rules under test:
 *  - a non-array batch throws `tasks must be an array`, naming the
 *    function, before any filter is read
 *  - a non-task entry throws naming its index
 *  - `tasksByFilters([null], {})` no longer silently returns `[null]`
 *  - a shape-only stand-in is rejected by `expiredTasks()` /
 *    `tasksByFilters()` (the `instanceof` choice, pinned so a later
 *    "helpful" widening to a shape check fails) but still passes
 *    `unreconciledPayouts()` (the #893 stand-in, pinned the other way)
 *  - the batch guard runs before filter-parameter validation, so a
 *    malformed batch is never masked by a bad filter value
 *  - `payoutAging()` / `expireOverdueTasks()` inherit the guard
 *    through the selector they call (same named error, no duplicate
 *    guard)
 *  - legal batches keep exactly their old selections
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
  expiredTasks,
  payoutAging,
  tasksByFilters,
  unreconciledPayouts,
} from "../src/index.js";

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const NOW = new Date("2026-10-04T00:00:00.000Z");

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** DRAFT → … → PAID, with an optional payoutRef and payoutAmount on the completion entry. */
function toPaid(
  id: string,
  completionRef?: string,
  completionAmount?: number,
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(completionRef !== undefined ? { payoutRef: completionRef } : {}),
    ...(completionAmount !== undefined
      ? { payoutAmount: completionAmount }
      : {}),
  });
  return t;
}

/** DRAFT → ACCEPTED, with a past SLA deadline for its current state. */
function overdueAccepted(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.setSlaDeadline(PAST);
  return t;
}

test("unreconciledPayouts: null batch throws a named error, not a bare TypeError", () => {
  // Shape-guard wording (assertTaskBatch, backlog #1341): no
  // `got …` suffix on the array check, unlike the instanceof guard.
  assert.throws(
    () => unreconciledPayouts(null as unknown as TaskLifecycle[]),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "invalid unreconciledPayouts: tasks must be an array",
  );
});

test("unreconciledPayouts: string and number batches throw the same named error", () => {
  for (const bad of ["x", 42]) {
    assert.throws(
      () => unreconciledPayouts(bad as unknown as TaskLifecycle[]),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "invalid unreconciledPayouts: tasks must be an array",
    );
  }
});

test("unreconciledPayouts: null and string entries throw naming their index", () => {
  // Shape-guard wording (assertTaskBatch, backlog #1341): the entry
  // must be a task object with a string id, string state, and array
  // history — the #893 stand-in still passes, so this is a shape
  // check, not instanceof.
  assert.throws(
    () => unreconciledPayouts([null as unknown as TaskLifecycle]),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid unreconciledPayouts: tasks[0] must be a task object with a string id, string state, and array history, got null",
  );
  const paid = toPaid("paid-1");
  assert.throws(
    () =>
      unreconciledPayouts([paid, "x" as unknown as TaskLifecycle]),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        'invalid unreconciledPayouts: tasks[1] must be a task object with a string id, string state, and array history, got "x"',
  );
});

test("unreconciledPayouts: the #893 defensive stand-in still passes", () => {
  // A PAID task with no PAYOUT_COMPLETE entry at all: unreachable
  // through the validated construction paths, but the screen flags
  // it as unreconciled instead of rejecting it — pinned so a later
  // "helpful" tightening to instanceof fails loudly.
  const standIn = { id: "stand-in", state: "PAID", history: [] };
  assert.deepEqual(
    unreconciledPayouts([standIn as unknown as TaskLifecycle]).map(
      (t) => t.id,
    ),
    ["stand-in"],
  );
});

test("expiredTasks: non-array batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => expiredTasks(bad as unknown as TaskLifecycle[], NOW),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          `invalid expiredTasks: tasks must be an array, got ${bad === null ? "null" : typeof bad}`,
    );
  }
});

test("expiredTasks: null entry throws naming its index, not a bare TypeError from getSlaDeadline", () => {
  assert.throws(
    () => expiredTasks([null as unknown as TaskLifecycle], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid expiredTasks: tasks[0] must be a TaskLifecycle, got null",
  );
});

test("expiredTasks and tasksByFilters: a shape-only stand-in is rejected, not treated as a task", () => {
  // Deliberate instanceof choice (backlog #1342, escrow #1340): the
  // selectors read getSlaDeadline()/isTerminal, which a plain object
  // cannot supply — pinned so a later "helpful" widening to a shape
  // check fails loudly instead of dying inside isOverdue.
  const standIn = { id: "stand-in", state: "ACCEPTED", history: [] };
  assert.throws(
    () =>
      expiredTasks([standIn as unknown as TaskLifecycle], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid expiredTasks: tasks[0] must be a TaskLifecycle, got object",
  );
  assert.throws(
    () =>
      tasksByFilters([standIn as unknown as TaskLifecycle], {}),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid tasksByFilters: tasks[0] must be a TaskLifecycle, got object",
  );
});

test("tasksByFilters: non-array batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    assert.throws(
      () => tasksByFilters(bad as unknown as TaskLifecycle[], {}),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          `invalid tasksByFilters: tasks must be an array, got ${bad === null ? "null" : typeof bad}`,
    );
  }
});

test("tasksByFilters: [null] with no filter axis no longer silently returns [null]", () => {
  assert.throws(
    () => tasksByFilters([null as unknown as TaskLifecycle], {}),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid tasksByFilters: tasks[0] must be a TaskLifecycle, got null",
  );
});

test("tasksByFilters: the batch guard runs before filter validation", () => {
  // A malformed batch is never masked by (or mistaken for) a bad
  // filter value: the batch error wins even when the filters are bad.
  assert.throws(
    () =>
      tasksByFilters(null as unknown as TaskLifecycle[], {
        state: "BOGUS" as never,
      }),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid tasksByFilters: tasks must be an array, got null",
  );
});

test("payoutAging: inherits the unreconciledPayouts guard, same named error", () => {
  assert.throws(
    () => payoutAging(null as unknown as TaskLifecycle[], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message === "invalid unreconciledPayouts: tasks must be an array",
  );
  assert.throws(
    () => payoutAging([null as unknown as TaskLifecycle], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid unreconciledPayouts: tasks[0] must be a task object with a string id, string state, and array history, got null",
  );
});

test("expireOverdueTasks: inherits the expiredTasks guard, same named error", () => {
  assert.throws(
    () => expireOverdueTasks(null as unknown as TaskLifecycle[], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid expiredTasks: tasks must be an array, got null",
  );
  assert.throws(
    () =>
      expireOverdueTasks([null as unknown as TaskLifecycle], NOW),
    (err: unknown) =>
      err instanceof Error &&
      err.message ===
        "invalid expiredTasks: tasks[0] must be a TaskLifecycle, got null",
  );
});

test("legal batches: unreconciledPayouts selection is unchanged", () => {
  const paidWithRef = toPaid("paid-with-ref", "xfer-88f2", 1000);
  const paidNoRef = toPaid("paid-no-ref");
  const inFlight = toApproved("in-flight");
  assert.deepEqual(
    unreconciledPayouts([paidWithRef, paidNoRef, inFlight]).map(
      (t) => t.id,
    ),
    ["paid-no-ref"],
  );
  assert.deepEqual(unreconciledPayouts([]), []);
});

test("legal batches: expiredTasks selection is unchanged", () => {
  const overdue = overdueAccepted("t-overdue");
  const notYet = new TaskLifecycle("t-notyet");
  notYet.dispatch("PUBLISH", { actor: "researcher" });
  notYet.dispatch("ACCEPT", { actor: "contributor" });
  notYet.setSlaDeadline(FUTURE);
  const noDeadline = new TaskLifecycle("t-nodeadline");
  noDeadline.dispatch("PUBLISH", { actor: "researcher" });
  noDeadline.dispatch("ACCEPT", { actor: "contributor" });
  assert.deepEqual(
    expiredTasks([overdue, notYet, noDeadline], NOW).map((t) => t.id),
    ["t-overdue"],
  );
  assert.deepEqual(expiredTasks([], NOW), []);
});

test("legal batches: tasksByFilters selection is unchanged, including the overdue axis", () => {
  const paid = toPaid("paid-1", "xfer-1", 500);
  const approved = toApproved("approved-1");
  const overdue = overdueAccepted("overdue-1");
  assert.deepEqual(
    tasksByFilters([paid, approved, overdue], { state: "PAID" }).map(
      (t) => t.id,
    ),
    ["paid-1"],
  );
  assert.deepEqual(
    tasksByFilters([paid, approved, overdue], {}).map((t) => t.id),
    ["paid-1", "approved-1", "overdue-1"],
  );
  assert.deepEqual(
    tasksByFilters([paid, approved, overdue], { overdue: true }, NOW).map(
      (t) => t.id,
    ),
    ["overdue-1"],
  );
  assert.deepEqual(
    tasksByFilters([paid, approved, overdue], { overdue: false }, NOW).map(
      (t) => t.id,
    ),
    ["paid-1", "approved-1"],
  );
});

test("legal batches: payoutAging buckets are unchanged", () => {
  // A PAID task with no payoutRef and no amount: unreconciled, and
  // with no PAYOUT_COMPLETE timestamp usable for aging it lands in
  // `unknown` only when the entry itself is absent — here the entry
  // exists with a dispatch timestamp, so it ages from that stamp.
  const paidNoRef = toPaid("paid-no-ref");
  const aging = payoutAging([paidNoRef], NOW);
  assert.equal(aging.unknown.length, 0);
  assert.equal(
    aging.under7Days.length +
      aging.days7To30.length +
      aging.over30Days.length,
    1,
  );
  assert.deepEqual(payoutAging([], NOW), {
    under7Days: [],
    days7To30: [],
    over30Days: [],
    unknown: [],
  });
});
