/**
 * Batch-read shape guards, second wave (backlog #1363).
 *
 * The four remaining batch readers that iterated their batch with no
 * array guard at all: `nextSlaDeadline()` / `nextTaskDeadline()` /
 * `tasksByState()` / `summarizeTaskSettlements()`. A `null` batch
 * died as a bare `TypeError` in each of them (`tasks is not
 * iterable` for the three iterators, `reading 'filter'` for
 * `tasksByState`), and a `[null]` batch died reading `isTerminal`,
 * `state`, or `id` one step in.
 *
 * Guard split, by what each reader touches — the same split as
 * backlog #1342/#1350:
 *  - `nextSlaDeadline` / `nextTaskDeadline` / `tasksByState` use the
 *    `instanceof TaskLifecycle` guard (`assertTaskInstanceBatch`):
 *    the first two read `isTerminal` and call `getSlaDeadline()`,
 *    and `tasksByState` is held to the same strength as
 *    `expiredTasks`, so a shape-only stand-in is rejected by all
 *    three (pinned, so a later "helpful" widening to a shape check
 *    fails)
 *  - `summarizeTaskSettlements` uses the shape guard
 *    (`assertTaskBatch`, backlog #1341): it reads only `id`,
 *    `state`, and `history`, and `payoutMismatch` shape-guards each
 *    PAID task the same way, so the #893 defensive stand-in — a
 *    PAID task with no `PAYOUT_COMPLETE` entry at all — keeps
 *    passing (pinned the other way)
 *
 * Rules under test:
 *  - a non-array batch throws a named error, never a bare TypeError
 *  - a non-task entry throws naming its index
 *  - the batch guard runs before any secondary-parameter validation
 *    (`now` for the deadline readers, the state for `tasksByState`,
 *    the duplicate-id scan for the summary), so a malformed batch
 *    is never masked by another bad value
 *  - legal batches keep exactly their old answers, and the #1324
 *    duplicate-task rejection in `summarizeTaskSettlements` is
 *    unchanged
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  nextSlaDeadline,
  nextTaskDeadline,
  summarizeTaskSettlements,
  tasksByState,
} from "../src/index.js";
import type { TaskState } from "../src/index.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR = 3600_000;

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

/** Drive a task to ACCEPTED. */
function acceptedTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

function deadlineAt(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

/** Drive a task to OPEN (one step before ACCEPT). */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  return t;
}

/** DRAFT → … → PAID, quoting on ACCEPT and settling on PAYOUT_COMPLETE. */
function toPaid(
  id: string,
  opts: { quoted?: number; paid?: number },
): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("ACCEPT", {
    actor: "contributor",
    ...(opts.quoted !== undefined ? { quotedAmount: opts.quoted } : {}),
  });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    ...(opts.paid !== undefined ? { payoutAmount: opts.paid } : {}),
  });
  return t;
}

/** The #893 defensive stand-in: a PAID task-shaped object with no PAYOUT_COMPLETE entry. */
const STAND_IN = { id: "STAND-IN", state: "PAID", history: [] };

// --- nextSlaDeadline ---

test("nextSlaDeadline: a non-array batch throws a named error, never a bare TypeError", () => {
  throwsNamed(
    () => nextSlaDeadline(null as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextSlaDeadline: tasks must be an array, got null',
  );
  throwsNamed(
    () => nextSlaDeadline("x" as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextSlaDeadline: tasks must be an array, got string',
  );
  throwsNamed(
    () => nextSlaDeadline(42 as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextSlaDeadline: tasks must be an array, got number',
  );
});

test("nextSlaDeadline: a non-task entry throws naming its index", () => {
  throwsNamed(
    () => nextSlaDeadline([null as unknown as TaskLifecycle], NOW),
    'invalid nextSlaDeadline: tasks[0] must be a TaskLifecycle, got null',
  );
  throwsNamed(
    () => nextSlaDeadline([42 as unknown as TaskLifecycle], NOW),
    'invalid nextSlaDeadline: tasks[0] must be a TaskLifecycle, got number',
  );
  throwsNamed(
    () =>
      nextSlaDeadline(
        [acceptedTask("ok"), null as unknown as TaskLifecycle],
        NOW,
      ),
    'invalid nextSlaDeadline: tasks[1] must be a TaskLifecycle, got null',
  );
});

test("nextSlaDeadline: the batch guard runs before the now check", () => {
  throwsNamed(
    () =>
      nextSlaDeadline(
        null as unknown as readonly TaskLifecycle[],
        new Date("not-a-date"),
      ),
    'invalid nextSlaDeadline: tasks must be an array, got null',
  );
});

test("nextSlaDeadline: a shape-only stand-in is rejected", () => {
  throwsNamed(
    () =>
      nextSlaDeadline(
        [STAND_IN as unknown as TaskLifecycle],
        NOW,
      ),
    'invalid nextSlaDeadline: tasks[0] must be a TaskLifecycle, got object',
  );
});

test("nextSlaDeadline: legal batches keep their old answer", () => {
  const later = acceptedTask("t-later");
  later.setSlaDeadline(deadlineAt(5 * HOUR));
  const earliest = acceptedTask("t-earliest");
  earliest.setSlaDeadline(deadlineAt(2 * HOUR));
  const next = nextSlaDeadline([later, earliest], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-earliest");
  assert.equal(next.deadline, deadlineAt(2 * HOUR).toISOString());
  assert.equal(nextSlaDeadline([], NOW), undefined);
});

// --- nextTaskDeadline ---

test("nextTaskDeadline: a non-array batch throws a named error, never a bare TypeError", () => {
  throwsNamed(
    () => nextTaskDeadline(null as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextTaskDeadline: tasks must be an array, got null',
  );
  throwsNamed(
    () => nextTaskDeadline("x" as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextTaskDeadline: tasks must be an array, got string',
  );
  throwsNamed(
    () => nextTaskDeadline(42 as unknown as readonly TaskLifecycle[], NOW),
    'invalid nextTaskDeadline: tasks must be an array, got number',
  );
});

test("nextTaskDeadline: a non-task entry throws naming its index", () => {
  throwsNamed(
    () => nextTaskDeadline([null as unknown as TaskLifecycle], NOW),
    'invalid nextTaskDeadline: tasks[0] must be a TaskLifecycle, got null',
  );
  throwsNamed(
    () => nextTaskDeadline([42 as unknown as TaskLifecycle], NOW),
    'invalid nextTaskDeadline: tasks[0] must be a TaskLifecycle, got number',
  );
  throwsNamed(
    () =>
      nextTaskDeadline(
        [acceptedTask("ok"), null as unknown as TaskLifecycle],
        NOW,
      ),
    'invalid nextTaskDeadline: tasks[1] must be a TaskLifecycle, got null',
  );
});

test("nextTaskDeadline: the batch guard runs before the now check", () => {
  throwsNamed(
    () =>
      nextTaskDeadline(
        null as unknown as readonly TaskLifecycle[],
        new Date("not-a-date"),
      ),
    'invalid nextTaskDeadline: tasks must be an array, got null',
  );
});

test("nextTaskDeadline: a shape-only stand-in is rejected", () => {
  throwsNamed(
    () =>
      nextTaskDeadline(
        [STAND_IN as unknown as TaskLifecycle],
        NOW,
      ),
    'invalid nextTaskDeadline: tasks[0] must be a TaskLifecycle, got object',
  );
});

test("nextTaskDeadline: legal batches keep their old answer", () => {
  // Whole-map scan: a deadline on a departed state still counts here.
  const task = acceptedTask("t-planned");
  task.setSlaDeadline(deadlineAt(HOUR), "OPEN");
  task.setSlaDeadline(deadlineAt(2 * HOUR)); // current state ACCEPTED
  const next = nextTaskDeadline([task], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-planned");
  assert.equal(next.state, "OPEN");
  assert.equal(next.deadline, deadlineAt(HOUR).toISOString());
  assert.equal(nextTaskDeadline([], NOW), undefined);
});

// --- tasksByState ---

test("tasksByState: a non-array batch throws a named error, never a bare TypeError", () => {
  throwsNamed(
    () => tasksByState(null as unknown as readonly TaskLifecycle[], "PAID"),
    'invalid tasksByState: tasks must be an array, got null',
  );
  throwsNamed(
    () => tasksByState("x" as unknown as readonly TaskLifecycle[], "PAID"),
    'invalid tasksByState: tasks must be an array, got string',
  );
  throwsNamed(
    () => tasksByState(42 as unknown as readonly TaskLifecycle[], "PAID"),
    'invalid tasksByState: tasks must be an array, got number',
  );
});

test("tasksByState: a non-task entry throws naming its index", () => {
  throwsNamed(
    () => tasksByState([null as unknown as TaskLifecycle], "PAID"),
    'invalid tasksByState: tasks[0] must be a TaskLifecycle, got null',
  );
  throwsNamed(
    () => tasksByState([42 as unknown as TaskLifecycle], "PAID"),
    'invalid tasksByState: tasks[0] must be a TaskLifecycle, got number',
  );
  throwsNamed(
    () =>
      tasksByState(
        [acceptedTask("ok"), null as unknown as TaskLifecycle],
        "PAID",
      ),
    'invalid tasksByState: tasks[1] must be a TaskLifecycle, got null',
  );
});

test("tasksByState: the batch guard runs before the state check", () => {
  throwsNamed(
    () =>
      tasksByState(
        null as unknown as readonly TaskLifecycle[],
        "NOPE" as TaskState,
      ),
    'invalid tasksByState: tasks must be an array, got null',
  );
});

test("tasksByState: a shape-only stand-in is rejected", () => {
  throwsNamed(
    () => tasksByState([STAND_IN as unknown as TaskLifecycle], "PAID"),
    'invalid tasksByState: tasks[0] must be a TaskLifecycle, got object',
  );
});

test("tasksByState: legal batches keep their old answer", () => {
  const open = toOpen("t-open");
  const accepted = acceptedTask("t-accepted");
  const paid = toPaid("t-paid", { quoted: 10, paid: 10 });
  assert.deepEqual(
    tasksByState([open, accepted, paid], "OPEN").map((t) => t.id),
    ["t-open"],
  );
  assert.deepEqual(
    tasksByState([open, accepted, paid], "PAID").map((t) => t.id),
    ["t-paid"],
  );
  assert.deepEqual(tasksByState([], "OPEN"), []);
});

// --- summarizeTaskSettlements ---

test("summarizeTaskSettlements: a non-array batch throws a named error, never a bare TypeError", () => {
  throwsNamed(
    () =>
      summarizeTaskSettlements(
        null as unknown as readonly TaskLifecycle[],
      ),
    'invalid summarizeTaskSettlements: tasks must be an array',
  );
  throwsNamed(
    () =>
      summarizeTaskSettlements("x" as unknown as readonly TaskLifecycle[]),
    'invalid summarizeTaskSettlements: tasks must be an array',
  );
  throwsNamed(
    () =>
      summarizeTaskSettlements(42 as unknown as readonly TaskLifecycle[]),
    'invalid summarizeTaskSettlements: tasks must be an array',
  );
});

test("summarizeTaskSettlements: a non-task entry throws naming its index", () => {
  throwsNamed(
    () => summarizeTaskSettlements([null as unknown as TaskLifecycle]),
    'invalid summarizeTaskSettlements: tasks[0] must be a task object with a string id, string state, and array history, got null',
  );
  throwsNamed(
    () => summarizeTaskSettlements([42 as unknown as TaskLifecycle]),
    'invalid summarizeTaskSettlements: tasks[0] must be a task object with a string id, string state, and array history, got 42',
  );
  throwsNamed(
    () =>
      summarizeTaskSettlements([
        toOpen("ok"),
        { id: 1, state: "PAID", history: [] } as unknown as TaskLifecycle,
      ]),
    'invalid summarizeTaskSettlements: tasks[1] must be a task object with a string id, string state, and array history, got {"id":1,"state":"PAID","history":[]}',
  );
});

test("summarizeTaskSettlements: the batch guard runs before the duplicate-id scan", () => {
  // Two tasks sharing one id AND a null entry: the shape error at
  // index 2 must win over the #1324 duplicate-id error.
  throwsNamed(
    () =>
      summarizeTaskSettlements([
        toPaid("dup", { quoted: 10, paid: 10 }),
        toPaid("dup", { quoted: 10, paid: 10 }),
        null as unknown as TaskLifecycle,
      ]),
    'invalid summarizeTaskSettlements: tasks[2] must be a task object with a string id, string state, and array history, got null',
  );
});

test("summarizeTaskSettlements: the #893 defensive stand-in still passes", () => {
  assert.deepEqual(
    summarizeTaskSettlements([STAND_IN as unknown as TaskLifecycle]),
    {
      tasks: 1,
      paid: 1,
      quotedTotal: 0,
      paidTotal: 0,
      gap: 0,
      mismatched: 0,
      unquotedPaid: 1,
      unquotedPaidTotal: 0,
    },
  );
});

test("summarizeTaskSettlements: legal batches keep their old answer", () => {
  const summary = summarizeTaskSettlements([
    toPaid("s-a", { quoted: 100, paid: 100 }),
    toPaid("s-b", { quoted: 250, paid: 260 }),
    toOpen("s-c"),
  ]);
  assert.deepEqual(summary, {
    tasks: 3,
    paid: 2,
    quotedTotal: 35000,
    paidTotal: 36000,
    gap: -1000,
    mismatched: 1,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
  assert.deepEqual(summarizeTaskSettlements([]), {
    tasks: 0,
    paid: 0,
    quotedTotal: 0,
    paidTotal: 0,
    gap: 0,
    mismatched: 0,
    unquotedPaid: 0,
    unquotedPaidTotal: 0,
  });
});

test("summarizeTaskSettlements: the #1324 duplicate-task rejection is unchanged", () => {
  throwsNamed(
    () =>
      summarizeTaskSettlements([
        toPaid("dup", { quoted: 10, paid: 10 }),
        toPaid("dup", { quoted: 10, paid: 10 }),
      ]),
    'invalid summarizeTaskSettlements: duplicate task "dup"',
  );
});
