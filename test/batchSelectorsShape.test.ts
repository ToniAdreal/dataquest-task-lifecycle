/**
 * Single-axis batch-selector shape guards (backlog #1350).
 *
 * `tasksByPayoutRef()` / `tasksByActor()` / `tasksByEvent()` /
 * `tasksApproachingDeadline()` / `staleTasks()` validated only their
 * secondary parameters, never the batch itself: a `null` batch died
 * as a bare `TypeError` (`reading 'filter'`), a `[null]` batch died
 * reading `history` (the first three) or `isTerminal` (the last
 * two). Two guards, by what each selector reads — the same split as
 * backlog #1342: the first three read only `state` and `history`,
 * so they use the shape guard (`assertTaskBatch`, backlog #1341)
 * and the #893 defensive stand-in keeps passing; the last two read
 * `isTerminal` and `getSlaDeadline()`, so they use `instanceof
 * TaskLifecycle` (`assertTaskInstanceBatch`) and a shape-only
 * stand-in is rejected.
 *
 * Rules under test:
 *  - a non-array batch throws `tasks must be an array`, naming the
 *    function, before any secondary parameter is read
 *  - a non-task entry throws naming its index
 *  - the batch guard runs before secondary-parameter validation, so
 *    a malformed batch is never masked by a bad filter value
 *  - a shape-only stand-in still passes the first three selectors
 *    (the #893 stand-in, pinned the other way) but is rejected by
 *    the last two (the `instanceof` choice, pinned so a later
 *    "helpful" widening to a shape check fails)
 *  - legal batches keep exactly their old selections
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  staleTasks,
  tasksApproachingDeadline,
  tasksByActor,
  tasksByEvent,
  tasksByPayoutRef,
} from "../src/index.js";
import type {
  TaskEvent,
  TaskHistoryEntry,
  TaskState,
} from "../src/index.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;

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

/** Build a task by dispatching (event, actor?) pairs in order. */
function taskWithHistory(
  id: string,
  steps: [TaskEvent, string?][],
): TaskLifecycle {
  const task = new TaskLifecycle(id);
  for (const [event, actor] of steps) {
    task.dispatch(event, actor === undefined ? {} : { actor });
  }
  return task;
}

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

/** DRAFT → … → PAID, with an optional payoutRef on the completion entry. */
function toPaid(id: string, completionRef?: string): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(completionRef !== undefined ? { payoutRef: completionRef } : {}),
  });
  return t;
}

/** DRAFT → ACCEPTED, with an SLA deadline for its current state. */
function acceptedTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

type Step = [TaskEvent, TaskState, TaskState, string];

/** Build a task deterministically: entries carry fixed timestamps. */
function taskAt(id: string, steps: Step[]): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(
    ([event, from, to, at], i) => ({
      seq: i + 1,
      event,
      from,
      to,
      at,
      actor: "system",
    }),
  );
  return TaskLifecycle.fromHistory(id, history);
}

const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string =>
  iso(new Date(NOW.getTime() - n * DAY));

test("tasksByPayoutRef: null, string, and number batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    throwsNamed(
      () =>
        tasksByPayoutRef(bad as unknown as TaskLifecycle[], "xfer-1"),
      "invalid tasksByPayoutRef: tasks must be an array",
    );
  }
});

test("tasksByActor: null, string, and number batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    throwsNamed(
      () => tasksByActor(bad as unknown as TaskLifecycle[], "alice"),
      "invalid tasksByActor: tasks must be an array",
    );
  }
});

test("tasksByEvent: null, string, and number batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    throwsNamed(
      () => tasksByEvent(bad as unknown as TaskLifecycle[], "DISPUTE"),
      "invalid tasksByEvent: tasks must be an array",
    );
  }
});

test("tasksApproachingDeadline: null, string, and number batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    throwsNamed(
      () =>
        tasksApproachingDeadline(
          bad as unknown as TaskLifecycle[],
          HOUR,
          NOW,
        ),
      "invalid tasksApproachingDeadline: tasks must be an array, got " +
        (bad === null ? "null" : typeof bad),
    );
  }
});

test("staleTasks: null, string, and number batches throw a named error", () => {
  for (const bad of [null, "x", 42]) {
    throwsNamed(
      () => staleTasks(bad as unknown as TaskLifecycle[], {}, NOW),
      "invalid staleTasks: tasks must be an array, got " +
        (bad === null ? "null" : typeof bad),
    );
  }
});

test("single-axis selectors: a null entry throws naming its index", () => {
  throwsNamed(
    () => tasksByPayoutRef([null as unknown as TaskLifecycle], "xfer-1"),
    "invalid tasksByPayoutRef: tasks[0] must be a task object with a string id, string state, and array history, got null",
  );
  throwsNamed(
    () => tasksByActor([null as unknown as TaskLifecycle], "alice"),
    "invalid tasksByActor: tasks[0] must be a task object with a string id, string state, and array history, got null",
  );
  throwsNamed(
    () => tasksByEvent([null as unknown as TaskLifecycle], "DISPUTE"),
    "invalid tasksByEvent: tasks[0] must be a task object with a string id, string state, and array history, got null",
  );
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [null as unknown as TaskLifecycle],
        HOUR,
        NOW,
      ),
    "invalid tasksApproachingDeadline: tasks[0] must be a TaskLifecycle, got null",
  );
  throwsNamed(
    () => staleTasks([null as unknown as TaskLifecycle], {}, NOW),
    "invalid staleTasks: tasks[0] must be a TaskLifecycle, got null",
  );
});

test("single-axis selectors: a bad entry after a good one names its index", () => {
  const good = taskWithHistory("t-good", [["PUBLISH", "alice"]]);
  throwsNamed(
    () =>
      tasksByActor(
        [good, "x" as unknown as TaskLifecycle],
        "alice",
      ),
    'invalid tasksByActor: tasks[1] must be a task object with a string id, string state, and array history, got "x"',
  );
  const accepted = acceptedTask("t-accepted");
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [accepted, "x" as unknown as TaskLifecycle],
        HOUR,
        NOW,
      ),
    "invalid tasksApproachingDeadline: tasks[1] must be a TaskLifecycle, got string",
  );
});

test("tasksByPayoutRef / tasksByActor / tasksByEvent: the #893 defensive stand-in still passes", () => {
  // A PAID task with no PAYOUT_COMPLETE entry at all: unreachable
  // through the validated construction paths, but the shape guard
  // only reads id/state/history, so it must keep flowing through.
  const standIn = { id: "stand-in", state: "PAID", history: [] };
  assert.deepEqual(
    tasksByActor([standIn as unknown as TaskLifecycle], "alice"),
    [],
  );
  assert.deepEqual(
    tasksByPayoutRef([standIn as unknown as TaskLifecycle], "xfer-1"),
    [],
  );
  assert.deepEqual(
    tasksByEvent([standIn as unknown as TaskLifecycle], "DISPUTE"),
    [],
  );
  // …and a stand-in whose history does carry the evidence matches.
  const matching = {
    id: "stand-in-match",
    state: "PAID",
    history: [
      { event: "PAYOUT_COMPLETE", payoutRef: "xfer-1", actor: "alice" },
    ],
  };
  assert.deepEqual(
    tasksByActor([matching as unknown as TaskLifecycle], "alice").map(
      (t) => t.id,
    ),
    ["stand-in-match"],
  );
  assert.deepEqual(
    tasksByPayoutRef(
      [matching as unknown as TaskLifecycle],
      "xfer-1",
    ).map((t) => t.id),
    ["stand-in-match"],
  );
  assert.deepEqual(
    tasksByEvent(
      [matching as unknown as TaskLifecycle],
      "PAYOUT_COMPLETE",
    ).map((t) => t.id),
    ["stand-in-match"],
  );
});

test("tasksApproachingDeadline / staleTasks: a shape-only stand-in is rejected, not treated as a task", () => {
  const standIn = { id: "stand-in", state: "PAID", history: [] };
  throwsNamed(
    () =>
      tasksApproachingDeadline(
        [standIn as unknown as TaskLifecycle],
        HOUR,
        NOW,
      ),
    "invalid tasksApproachingDeadline: tasks[0] must be a TaskLifecycle, got object",
  );
  throwsNamed(
    () => staleTasks([standIn as unknown as TaskLifecycle], {}, NOW),
    "invalid staleTasks: tasks[0] must be a TaskLifecycle, got object",
  );
});

test("single-axis selectors: the batch guard runs before secondary-parameter validation", () => {
  // A malformed batch is never masked by (or mistaken for) a bad
  // filter value: the batch error wins even when the filter value
  // would itself fail fast.
  throwsNamed(
    () => tasksByActor(null as unknown as TaskLifecycle[], ""),
    "invalid tasksByActor: tasks must be an array",
  );
  throwsNamed(
    () => tasksByPayoutRef(null as unknown as TaskLifecycle[], ""),
    "invalid tasksByPayoutRef: tasks must be an array",
  );
  throwsNamed(
    () =>
      tasksByEvent(
        null as unknown as TaskLifecycle[],
        "NOPE" as TaskEvent,
      ),
    "invalid tasksByEvent: tasks must be an array",
  );
  throwsNamed(
    () =>
      tasksApproachingDeadline(null as unknown as TaskLifecycle[], -1, NOW),
    "invalid tasksApproachingDeadline: tasks must be an array, got null",
  );
  throwsNamed(
    () =>
      staleTasks(null as unknown as TaskLifecycle[], { OPEN: -1 }, NOW),
    "invalid staleTasks: tasks must be an array, got null",
  );
});

test("tasksByPayoutRef: legal batches keep their old selections", () => {
  const settled = toPaid("t-settled", "xfer-1");
  const otherRef = toPaid("t-other", "xfer-2");
  const unsettled = toApproved("t-open");
  assert.deepEqual(
    tasksByPayoutRef([settled, otherRef, unsettled], "xfer-1").map(
      (t) => t.id,
    ),
    ["t-settled"],
  );
  assert.deepEqual(tasksByPayoutRef([settled, otherRef], "xfer-9"), []);
});

test("tasksByActor: legal batches keep their old selections", () => {
  const batch = [
    taskWithHistory("t-a", [
      ["PUBLISH", "alice"],
      ["ACCEPT", "bob"],
    ]),
    taskWithHistory("t-b", [["PUBLISH", "bob"]]),
    taskWithHistory("t-c", [["PUBLISH", "alice"]]),
  ];
  assert.deepEqual(
    tasksByActor(batch, "alice").map((t) => t.id),
    ["t-a", "t-c"],
  );
  assert.deepEqual(
    tasksByActor(batch, "bob").map((t) => t.id),
    ["t-a", "t-b"],
  );
});

test("tasksByEvent: legal batches keep their old selections", () => {
  const batch = [
    taskWithHistory("t-a", [["PUBLISH", "alice"], ["ACCEPT", "bob"]]),
    taskWithHistory("t-b", [["PUBLISH", "bob"]]),
  ];
  assert.deepEqual(
    tasksByEvent(batch, "ACCEPT").map((t) => t.id),
    ["t-a"],
  );
  assert.deepEqual(
    tasksByEvent(batch, "PUBLISH").map((t) => t.id),
    ["t-a", "t-b"],
  );
});

test("tasksApproachingDeadline: legal batches keep their old selections", () => {
  const inside = acceptedTask("t-inside");
  inside.setSlaDeadline(new Date(NOW.getTime() + 2 * HOUR));
  const outside = acceptedTask("t-outside");
  outside.setSlaDeadline(new Date(NOW.getTime() + 48 * HOUR));
  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(new Date(NOW.getTime() - HOUR));
  assert.deepEqual(
    tasksApproachingDeadline([inside, outside, overdue], 24 * HOUR, NOW).map(
      (t) => t.id,
    ),
    ["t-inside"],
  );
});

test("staleTasks: legal batches keep their old selections", () => {
  const staleOpen = taskAt("t-stale-open", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
  ]);
  const freshOpen = taskAt("t-fresh-open", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(3)],
  ]);
  assert.deepEqual(
    staleTasks([staleOpen, freshOpen], { OPEN: 30 * DAY }, NOW).map(
      (t) => t.id,
    ),
    ["t-stale-open"],
  );
  assert.deepEqual(staleTasks([], { OPEN: 30 * DAY }, NOW), []);
});
