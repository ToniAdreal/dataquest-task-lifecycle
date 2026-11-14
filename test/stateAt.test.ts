import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  stateAtFromHistory,
  type TaskHistoryEntry,
} from "../src/index.js";

/**
 * `stateAt(time)` / `stateAtFromHistory(history, time)` (backlog #1130):
 * read-only time travel over the append-only audit history.
 *
 * Rules under test:
 *  - the state at a moment is the `to` of the last entry at or before it
 *  - the boundary is inclusive: a query exactly on an entry's `at` sees
 *    that entry's effect (same boundary isOverdue uses)
 *  - a time before the first entry returns the initial state, "DRAFT"
 *  - a time after the last entry returns the final state
 *  - a Date and the same moment as a string agree
 *  - an invalid time throws `invalid stateAt time: …` before anything
 *    is read; a broken history throws `invalid history: …`
 *  - the pure function and the instance method agree on every probe
 *  - the query is a pure read: state/history untouched, dispatching
 *    afterwards continues at the next seq
 *  - an empty history replays to "DRAFT" at any time
 *  - a keyed (HMAC) chain needs its secret, like rehydration does
 */

const T10 = "2026-03-01T10:00:00.000Z";
const T11 = "2026-03-01T11:00:00.000Z";
const T12 = "2026-03-01T12:00:00.000Z";
const T13 = "2026-03-01T13:00:00.000Z";

/** PUBLISH @10:00, ACCEPT @11:00, START_CAPTURE @12:00, SUBMIT @13:00. */
function buildTask(): TaskLifecycle {
  const task = new TaskLifecycle("task-042");
  task.dispatch("PUBLISH", { at: T10 });
  task.dispatch("ACCEPT", { at: T11 });
  task.dispatch("START_CAPTURE", { at: T12 });
  task.dispatch("SUBMIT", { at: T13 });
  return task;
}

test("stateAt: a moment between entries returns the intermediate state", () => {
  const task = buildTask();
  assert.equal(task.stateAt("2026-03-01T10:30:00.000Z"), "OPEN");
  assert.equal(task.stateAt("2026-03-01T11:30:00.000Z"), "ACCEPTED");
  assert.equal(task.stateAt("2026-03-01T12:30:00.000Z"), "CAPTURING");
});

test("stateAt: a moment after the last entry returns the final state", () => {
  const task = buildTask();
  assert.equal(task.stateAt("2026-03-02T00:00:00.000Z"), "SUBMITTED");
  assert.equal(task.stateAt(new Date("2027-01-01T00:00:00.000Z")), "SUBMITTED");
});

test("stateAt: a moment before the first entry returns the initial state", () => {
  const task = buildTask();
  assert.equal(task.stateAt("2026-03-01T09:59:59.999Z"), "DRAFT");
  assert.equal(task.stateAt("2026-01-01T00:00:00.000Z"), "DRAFT");
});

test("stateAt: a query exactly on an entry timestamp sees that entry's effect", () => {
  const task = buildTask();
  assert.equal(task.stateAt(T10), "OPEN");
  assert.equal(task.stateAt(T11), "ACCEPTED");
  assert.equal(task.stateAt(T12), "CAPTURING");
  assert.equal(task.stateAt(T13), "SUBMITTED");
});

test("stateAt: a Date and the same moment as a string agree", () => {
  const task = buildTask();
  for (const probe of [T10, T11, T12, T13, "2026-03-01T11:30:00.000Z"]) {
    assert.equal(
      task.stateAt(new Date(probe)),
      task.stateAt(probe),
      `probe ${probe}`,
    );
  }
});

test("stateAt: invalid times throw before anything is read", () => {
  const task = buildTask();
  const bad: unknown[] = [
    "not-a-date",
    "2026-13-01T10:00:00.000Z",
    new Date(Number.NaN),
    1772342400000,
    null,
    undefined,
    {},
  ];
  for (const time of bad) {
    assert.throws(
      () => task.stateAt(time as never),
      /invalid stateAt time: expected a valid Date or ISO-8601 string/,
      `time=${String(time)}`,
    );
    assert.throws(
      () => stateAtFromHistory(task.history, time as never),
      /invalid stateAt time: expected a valid Date or ISO-8601 string/,
      `pure time=${String(time)}`,
    );
  }
  assert.equal(task.state, "SUBMITTED");
  assert.equal(task.history.length, 4);
});

test("stateAtFromHistory: a broken history throws instead of guessing a state", () => {
  const task = buildTask();
  const broken = task.history.map((entry) => ({ ...entry }));
  // Break the chain: entry 2 claims to start from DRAFT, not OPEN.
  (broken[1] as TaskHistoryEntry).from = "DRAFT";
  assert.throws(
    () => stateAtFromHistory(broken, T12),
    /invalid history: entry\[1\]: from DRAFT does not continue previous to OPEN/,
  );
  // A truncated log (missing the final entry) is a different break.
  const truncated = task.history.slice(0, 2).map((entry) => ({ ...entry }));
  (truncated[1] as TaskHistoryEntry).seq = 3;
  assert.throws(
    () => stateAtFromHistory(truncated, T12),
    /invalid history: entry\[1\]: seq must be 2, got 3/,
  );
});

test("stateAtFromHistory: pure function and instance method agree on every probe", () => {
  const task = buildTask();
  const probes = [
    "2026-02-28T23:59:59.999Z",
    T10,
    "2026-03-01T10:00:00.001Z",
    T11,
    "2026-03-01T11:59:59.999Z",
    T12,
    T13,
    "2026-03-01T13:00:00.001Z",
    "2026-04-01T00:00:00.000Z",
  ];
  for (const probe of probes) {
    assert.equal(
      stateAtFromHistory(task.history, probe),
      task.stateAt(probe),
      `probe ${probe}`,
    );
  }
  // The pure form also works on a plain JSON round-trip of the log.
  const log = JSON.parse(JSON.stringify(task.history)) as unknown;
  assert.equal(stateAtFromHistory(log, T12), "CAPTURING");
});

test("stateAt: the query is a pure read — dispatching afterwards continues", () => {
  const task = buildTask();
  assert.equal(task.stateAt(T11), "ACCEPTED");
  assert.equal(task.state, "SUBMITTED");
  assert.equal(task.history.length, 4);
  task.dispatch("BEGIN_REVIEW", { at: "2026-03-01T14:00:00.000Z" });
  assert.equal(task.state, "IN_REVIEW");
  assert.equal(task.history.length, 5);
  assert.equal(task.history[4].seq, 5);
  assert.equal(task.stateAt(T13), "SUBMITTED");
  assert.equal(task.stateAt("2026-03-01T14:00:00.000Z"), "IN_REVIEW");
});

test("stateAtFromHistory: an empty history is DRAFT at any time", () => {
  assert.equal(stateAtFromHistory([], T10), "DRAFT");
  assert.equal(stateAtFromHistory([], "2027-01-01T00:00:00.000Z"), "DRAFT");
  const fresh = new TaskLifecycle("task-fresh");
  assert.equal(fresh.stateAt(T10), "DRAFT");
  assert.equal(fresh.stateAt(new Date()), "DRAFT");
});

test("stateAt: two entries at the same timestamp both count (non-decreasing)", () => {
  const task = new TaskLifecycle("task-same-at");
  task.dispatch("PUBLISH", { at: T10 });
  task.dispatch("ACCEPT", { at: T10 }); // equal timestamps are legal
  assert.equal(task.stateAt(T10), "ACCEPTED");
  assert.equal(task.stateAt("2026-03-01T09:59:59.999Z"), "DRAFT");
});

test("stateAtFromHistory: a keyed chain needs its secret, like rehydration", () => {
  const task = new TaskLifecycle("task-keyed", { auditSecret: "s3cr3t" });
  task.dispatch("PUBLISH", { at: T10 });
  task.dispatch("ACCEPT", { at: T11 });
  const log = JSON.parse(JSON.stringify(task.history)) as unknown;
  assert.equal(
    stateAtFromHistory(log, "2026-03-01T10:30:00.000Z", {
      auditSecret: "s3cr3t",
    }),
    "OPEN",
  );
  assert.equal(
    stateAtFromHistory(log, T11, { auditSecret: "s3cr3t" }),
    "ACCEPTED",
  );
  // No secret (or the wrong one) on a keyed chain is fail-closed.
  assert.throws(
    () => stateAtFromHistory(log, T11),
    /invalid history: history hash chain is broken/,
  );
  assert.throws(
    () => stateAtFromHistory(log, T11, { auditSecret: "wrong" }),
    /invalid history: history hash chain is broken/,
  );
});
