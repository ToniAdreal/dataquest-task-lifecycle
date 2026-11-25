/**
 * actOnStaleTasks omitted-`at` defaults to the screening `now` (backlog #1406).
 *
 * The sibling `expireOverdueTasks` already pins an omitted `at` to the
 * screening `now` (the #552 semantic): the audit entry carries the same
 * instant as the screening decision, never a wall-clock stamp. The
 * stale-task executor did not — with `at` omitted its default ABANDON
 * dispatch stamped the real wall clock, so a caller replaying a batch
 * at a fixed `now` got non-deterministic audit entries. This file pins
 * the fixed behaviour: omitted `at` means "stamp the screening `now`",
 * an explicit pin still wins, and a custom action still manages its
 * own timestamps.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, actOnStaleTasks } from "../src/index.js";
import type { TaskEvent, TaskHistoryEntry, TaskState } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/** Deterministic task builder, same pattern as actOnStaleTasks.test.ts. */
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

function acceptedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)], // 20d in ACCEPTED > 7d
  ]);
}

const BUDGET = {
  ACCEPTED: 7 * DAY,
  CAPTURING: 7 * DAY,
  SUBMITTED: 7 * DAY,
  OPEN: 30 * DAY,
  IN_REVIEW: 7 * DAY,
};

test("actOnStaleTasks: omitted at stamps the screening now, not the wall clock", () => {
  const task = acceptedStale("t-omitted-at");
  const results = actOnStaleTasks([task], undefined, BUDGET, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(results[0].entry?.at, NOW.toISOString());
  // The probe that motivated this fix: the screening instant is
  // 2026-10-06 while the wall clock runs 2026-11-25 — a wall-clock
  // stamp would be ~50 days later than the screening decision.
});

test("actOnStaleTasks: an explicit at pin still wins over the screening now", () => {
  const pin = "2026-10-07T09:30:00.000Z";
  const task = acceptedStale("t-explicit-at");
  const results = actOnStaleTasks([task], undefined, BUDGET, NOW, pin);
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(results[0].entry?.at, pin);
});

test("actOnStaleTasks: an explicit at as a Date still wins over the screening now", () => {
  const pin = new Date("2026-10-08T00:00:00.000Z");
  const task = acceptedStale("t-explicit-date-at");
  const results = actOnStaleTasks([task], undefined, BUDGET, NOW, pin);
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(results[0].entry?.at, pin.toISOString());
});

test("actOnStaleTasks: omitted at stamps every batch entry with the same screening now", () => {
  const first = acceptedStale("t-batch-1");
  const second = acceptedStale("t-batch-2");
  const results = actOnStaleTasks([first, second], undefined, BUDGET, NOW);
  assert.equal(results.length, 2);
  assert.equal(results[0].entry?.at, NOW.toISOString());
  assert.equal(results[1].entry?.at, NOW.toISOString());
});

test("actOnStaleTasks: omitted at and omitted now stamp the single call-time clock read", () => {
  // Stale against any real now: last entry decades in the past.
  const task = taskAt("t-default-now", [
    ["PUBLISH", "DRAFT", "OPEN", "2020-01-01T00:00:00.000Z"],
    ["ACCEPT", "OPEN", "ACCEPTED", "2020-01-02T00:00:00.000Z"],
  ]);
  const before = new Date().toISOString();
  const results = actOnStaleTasks([task], undefined, BUDGET);
  const after = new Date().toISOString();
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  const stamped = results[0].entry?.at ?? "";
  assert.ok(stamped >= before && stamped <= after, `entry.at ${stamped} outside [${before}, ${after}]`);
});

test("actOnStaleTasks: omitted at is deterministic — identical batches produce byte-identical entries", () => {
  const run = (id: string): string => {
    const task = acceptedStale(id);
    const results = actOnStaleTasks([task], undefined, BUDGET, NOW);
    assert.equal(results[0].acted, true);
    return JSON.stringify(results[0].entry);
  };
  assert.equal(run("t-det-1"), run("t-det-2"));
});

test("actOnStaleTasks: an invalid now still fails fast with a named error, not a bare RangeError", () => {
  const task = acceptedStale("t-bad-now");
  assert.throws(
    () => actOnStaleTasks([task], undefined, BUDGET, new Date(Number.NaN)),
    /invalid now: expected a valid Date/,
  );
  assert.throws(
    () =>
      actOnStaleTasks(
        [task],
        undefined,
        BUDGET,
        "2026-10-06T12:00:00.000Z" as unknown as Date,
      ),
    /invalid now: expected a valid Date/,
  );
  // Nothing was touched by the failed screening.
  assert.equal(task.state, "ACCEPTED");
  assert.equal(task.history.length, 2);
});

test("actOnStaleTasks: a custom action still ignores at, but a bad pin still fails fast", () => {
  const notified: string[] = [];
  const task = acceptedStale("t-custom-at");
  const results = actOnStaleTasks(
    [task],
    (t) => {
      notified.push(t.id);
    },
    BUDGET,
    NOW,
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(results[0].entry, undefined);
  assert.deepEqual(notified, ["t-custom-at"]);
  assert.equal(task.state, "ACCEPTED");
  assert.equal(task.history.length, 2);

  assert.throws(
    () =>
      actOnStaleTasks(
        [acceptedStale("t-bad-pin")],
        (t) => {
          notified.push(t.id);
        },
        BUDGET,
        NOW,
        "not-a-date",
      ),
    /invalid at: /,
  );
});
