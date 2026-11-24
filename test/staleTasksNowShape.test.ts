/**
 * `staleTasks()` `now` guard (backlog #1390).
 *
 * The watchdog read `now.getTime()` directly and only checked the
 * result with `Number.isFinite`, which catches an invalid Date but
 * not a `null` / non-Date `now` — those died as a bare TypeError
 * (`Cannot read properties of null (reading 'getTime')` /
 * `now.getTime is not a function`). The guard now matches
 * {@link isOverdue} / {@link expiredTasks} verbatim:
 * `!(now instanceof Date) || Number.isNaN(now.getTime())` throws
 * `invalid now: expected a valid Date`, placed after the batch and
 * budget checks and before any dwell time is read.
 *
 * Rules under test:
 *  - `null`, a string, a number, and a plain object `now` all throw
 *    the named error — never a TypeError
 *  - an invalid Date still throws the same named error (unchanged)
 *  - a valid `now` returns exactly the pre-guard selection (a task
 *    stuck in ACCEPTED past its budget is stale; a fresh task is not)
 *  - the guard runs before any dwell time is read: a bad `now` with
 *    an empty batch still reports `invalid now`, never an empty list
 *  - ordering is unchanged: a malformed batch / budget is still
 *    reported before a bad `now`
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, staleTasks } from "../src/index.js";
import type { TaskEvent, TaskHistoryEntry, TaskState } from "../src/index.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const DAY = 24 * 3600_000;
const BAD_NOW = "invalid now: expected a valid Date";
const BUDGET = { ACCEPTED: 7 * DAY, OPEN: 30 * DAY };

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

type Step = [TaskEvent, TaskState, TaskState, string];

function taskAt(id: string, steps: Step[]): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event,
    from,
    to,
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history);
}

const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

/** 20 days in ACCEPTED, past the 7-day budget. */
function acceptedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)],
  ]);
}

/** 1 day in ACCEPTED, inside the 7-day budget. */
function acceptedFresh(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(1)],
  ]);
}

test("null now throws the named error, never a TypeError", () => {
  throwsNamed(
    () => staleTasks([acceptedStale("t1")], BUDGET, null as unknown as Date),
    BAD_NOW,
  );
});

test("string / number / object now throw the named error", () => {
  for (const bad of ["bad", 42, {}]) {
    throwsNamed(
      () => staleTasks([acceptedStale("t1")], BUDGET, bad as unknown as Date),
      BAD_NOW,
    );
  }
});

test("invalid Date still throws the same named error", () => {
  throwsNamed(
    () => staleTasks([acceptedStale("t1")], BUDGET, new Date(NaN)),
    BAD_NOW,
  );
});

test("valid now keeps the pre-guard selection", () => {
  const found = staleTasks(
    [acceptedStale("stale"), acceptedFresh("fresh")],
    BUDGET,
    NOW,
  );
  assert.deepEqual(
    found.map((t) => t.id),
    ["stale"],
  );
});

test("bad now beats an empty batch: guard runs before any dwell read", () => {
  throwsNamed(() => staleTasks([], BUDGET, null as unknown as Date), BAD_NOW);
});

test("ordering unchanged: bad batch / bad budget before bad now", () => {
  assert.throws(
    () =>
      staleTasks(
        [null] as unknown as TaskLifecycle[],
        BUDGET,
        null as unknown as Date,
      ),
    (err: unknown) =>
      err instanceof Error && err.message.startsWith("invalid staleTasks:"),
  );
  assert.throws(
    () =>
      staleTasks(
        [acceptedStale("t1")],
        { ACCEPTED: -1 },
        null as unknown as Date,
      ),
    (err: unknown) => err instanceof Error && !err.message.includes("invalid now"),
  );
});
