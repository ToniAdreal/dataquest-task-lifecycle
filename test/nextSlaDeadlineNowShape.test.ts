/**
 * `nextSlaDeadline()` `now` guard (backlog #1390).
 *
 * The scheduler read `now.getTime()` directly and only checked the
 * result with `Number.isFinite`, which catches an invalid Date but
 * not a `null` / non-Date `now` — those died as a bare TypeError
 * (`Cannot read properties of null (reading 'getTime')` /
 * `now.getTime is not a function`). The guard now matches
 * {@link isOverdue} / {@link expiredTasks} verbatim:
 * `!(now instanceof Date) || Number.isNaN(now.getTime())` throws
 * `invalid now: expected a valid Date` before any deadline is read.
 *
 * Rules under test:
 *  - `null`, a string, a number, and a plain object `now` all throw
 *    the named error — never a TypeError
 *  - an invalid Date still throws the same named error (unchanged)
 *  - a valid `now` returns exactly the pre-guard result (earliest
 *    future deadline wins; ties keep input order)
 *  - the guard runs before any deadline is read: a bad `now` with a
 *    deadline-less batch still reports `invalid now`, never
 *    `undefined`
 *  - the batch guard still runs first: a malformed batch is never
 *    masked by a bad `now`
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, nextSlaDeadline } from "../src/index.js";

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
    () => nextSlaDeadline([deadlineTask("t1", HOUR)], null as unknown as Date),
    BAD_NOW,
  );
});

test("string / number / object now throw the named error", () => {
  for (const bad of ["bad", 42, {}]) {
    throwsNamed(
      () => nextSlaDeadline([deadlineTask("t1", HOUR)], bad as unknown as Date),
      BAD_NOW,
    );
  }
});

test("invalid Date still throws the same named error", () => {
  throwsNamed(
    () => nextSlaDeadline([deadlineTask("t1", HOUR)], new Date(NaN)),
    BAD_NOW,
  );
});

test("valid now returns the earliest future deadline, ties keep input order", () => {
  const early = deadlineTask("early", 2 * HOUR);
  const late = deadlineTask("late", 5 * HOUR);
  const next = nextSlaDeadline([late, early], NOW);
  assert.equal(next?.task.id, "early");
  assert.equal(next?.deadline, new Date(NOW.getTime() + 2 * HOUR).toISOString());
  assert.equal(nextSlaDeadline([deadlineTask("past", -HOUR)], NOW), undefined);
});

test("bad now beats a deadline-less batch: guard runs before any deadline read", () => {
  throwsNamed(
    () => nextSlaDeadline([new TaskLifecycle("bare")], null as unknown as Date),
    BAD_NOW,
  );
  throwsNamed(
    () => nextSlaDeadline([], null as unknown as Date),
    BAD_NOW,
  );
});

test("malformed batch is still reported before a bad now", () => {
  assert.throws(
    () =>
      nextSlaDeadline(
        [null] as unknown as TaskLifecycle[],
        null as unknown as Date,
      ),
    (err: unknown) =>
      err instanceof Error && err.message.startsWith("invalid nextSlaDeadline:"),
  );
});
