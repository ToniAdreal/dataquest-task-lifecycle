/**
 * `tasksApproachingDeadline()` `now` guard (backlog #1390).
 *
 * The watchdog read `now.getTime()` directly and only checked the
 * result with `Number.isFinite`, which catches an invalid Date but
 * not a `null` / non-Date `now` — those died as a bare TypeError
 * (`Cannot read properties of null (reading 'getTime')` /
 * `now.getTime is not a function`). The guard now matches
 * {@link isOverdue} / {@link expiredTasks} verbatim:
 * `!(now instanceof Date) || Number.isNaN(now.getTime())` throws
 * `invalid now: expected a valid Date`, placed after the `withinMs`
 * check and before any deadline is read.
 *
 * Rules under test:
 *  - `null`, a string, a number, and a plain object `now` all throw
 *    the named error — never a TypeError
 *  - an invalid Date still throws the same named error (unchanged)
 *  - a valid `now` returns exactly the pre-guard selection (deadline
 *    inside the window, past deadlines excluded)
 *  - the guard runs before any deadline is read: a bad `now` with a
 *    deadline-less batch still reports `invalid now`, never an empty
 *    list
 *  - ordering is unchanged: a bad `withinMs` is still reported before
 *    a bad `now`, and a malformed batch before both
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksApproachingDeadline } from "../src/index.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR = 3600_000;
const BAD_NOW = "invalid now: expected a valid Date";

/** Assert the call throws a plain Error (never a bare TypeError) with the exact message. */
function throwsNamed(fn: () => unknown, message: string): void {
  assert.throws(
    fn,
    (err: unknown) =>
      err instanceof Error &&
      !(err instanceof TypeError) &&
      err.message === message,
  );
}

function deadlineTask(id: string, offsetMs: number): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.setSlaDeadline(new Date(NOW.getTime() + offsetMs));
  return task;
}

test("null now throws the named error, never a TypeError", () => {
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [deadlineTask("t1", HOUR)],
        HOUR,
        null as unknown as Date,
      ),
    BAD_NOW,
  );
});

test("string / number / object now throw the named error", () => {
  for (const bad of ["bad", 42, {}]) {
    throwsNamed(
      () =>
        tasksApproachingDeadline(
          [deadlineTask("t1", HOUR)],
          HOUR,
          bad as unknown as Date,
        ),
      BAD_NOW,
    );
  }
});

test("invalid Date still throws the same named error", () => {
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [deadlineTask("t1", HOUR)],
        HOUR,
        new Date(NaN),
      ),
    BAD_NOW,
  );
});

test("valid now keeps the pre-guard selection", () => {
  const inside = deadlineTask("inside", 2 * HOUR);
  const outside = deadlineTask("outside", 48 * HOUR);
  const overdue = deadlineTask("overdue", -HOUR);
  const found = tasksApproachingDeadline(
    [inside, outside, overdue],
    24 * HOUR,
    NOW,
  );
  assert.deepEqual(
    found.map((t) => t.id),
    ["inside"],
  );
});

test("bad now beats a deadline-less batch: guard runs before any deadline read", () => {
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [new TaskLifecycle("bare")],
        HOUR,
        null as unknown as Date,
      ),
    BAD_NOW,
  );
  throwsNamed(
    () => tasksApproachingDeadline([], HOUR, null as unknown as Date),
    BAD_NOW,
  );
});

test("ordering unchanged: bad withinMs before bad now, bad batch before both", () => {
  assert.throws(
    () =>
      tasksApproachingDeadline(
        [deadlineTask("t1", HOUR)],
        -1,
        null as unknown as Date,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("invalid tasksApproachingDeadline:"),
  );
  assert.throws(
    () =>
      tasksApproachingDeadline(
        [null] as unknown as TaskLifecycle[],
        -1,
        null as unknown as Date,
      ),
    (err: unknown) =>
      err instanceof Error &&
      err.message.startsWith("invalid tasksApproachingDeadline:"),
  );
});
