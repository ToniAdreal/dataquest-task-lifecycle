import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, staleTasks } from "../src/index.js";
import type { TaskEvent, TaskHistoryEntry, TaskState } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/**
 * Build a task deterministically: entries carry fixed timestamps, so the
 * dwell clock is exact regardless of wall-clock time.
 */
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

const BUDGET = {
  IN_REVIEW: 7 * DAY, // reviews must not sit longer than a week
  OPEN: 30 * DAY, // unclaimed tasks get a month
};

test("staleTasks: screens a mixed batch by per-state dwell budget", () => {
  const staleReview = taskAt("t-stale-review", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(15)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(12)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(10)], // 10d in review > 7d
  ]);
  const freshReview = taskAt("t-fresh-review", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(5)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(3)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(2)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(1)], // 1d < 7d
  ]);
  const staleOpen = taskAt("t-stale-open", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)], // 40d open > 30d
  ]);
  const freshOpen = taskAt("t-fresh-open", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(3)], // 3d < 30d
  ]);

  const found = staleTasks(
    [staleReview, freshReview, staleOpen, freshOpen],
    BUDGET,
    NOW,
  );
  assert.deepEqual(
    found.map((t) => t.id),
    ["t-stale-review", "t-stale-open"], // input order preserved
  );
});

test("staleTasks: terminal tasks are never selected, however old", () => {
  const abandoned = taskAt("t-old-abandoned", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(400)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(390)],
    ["ABANDON", "ACCEPTED", "ABANDONED", daysAgo(380)], // terminal
  ]);
  const expired = taskAt("t-old-expired", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(400)],
    ["EXPIRE", "OPEN", "EXPIRED", daysAgo(390)], // terminal
  ]);
  const paid = taskAt("t-old-paid", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(400)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(390)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(380)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(370)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(360)],
    ["APPROVE", "IN_REVIEW", "APPROVED", daysAgo(350)],
    ["REQUEST_PAYOUT", "APPROVED", "PAYOUT_PENDING", daysAgo(340)],
    ["PAYOUT_COMPLETE", "PAYOUT_PENDING", "PAID", daysAgo(330)], // terminal
  ]);
  assert.deepEqual(
    staleTasks(
      [abandoned, expired, paid],
      { ABANDONED: 1, EXPIRED: 1, PAID: 1, OPEN: 1 },
      NOW,
    ),
    [],
  );
});

test("staleTasks: states absent from the budget are ignored", () => {
  const accepted = taskAt("t-no-budget", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(400)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(390)], // 390d, but no ACCEPTED budget
  ]);
  assert.deepEqual(staleTasks([accepted], BUDGET, NOW), []);
  assert.deepEqual(staleTasks([accepted], {}, NOW), []);
});

test("staleTasks: dwell is measured from the LAST history entry, not the first", () => {
  const oldTaskMovedRecently = taskAt("t-moved", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(60)], // old task...
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(55)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(50)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(45)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(2)], // ...but entered review 2d ago
  ]);
  assert.deepEqual(
    staleTasks([oldTaskMovedRecently], BUDGET, NOW),
    [],
  );
  const reverse = taskAt("t-moved2", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(60)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(55)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(50)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(10)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(10)], // 10d > 7d
  ]);
  assert.equal(staleTasks([reverse], BUDGET, NOW).length, 1);
});

test("staleTasks: empty input and fresh tasks without history", () => {
  assert.deepEqual(staleTasks([], BUDGET, NOW), []);
  // A task created but never dispatched is in DRAFT with no history —
  // no dwell time can be measured, so it is never stale.
  const fresh = new TaskLifecycle("t-fresh");
  assert.equal(fresh.history.length, 0);
  assert.deepEqual(
    staleTasks([fresh], { ...BUDGET, DRAFT: 1 }, NOW),
    [],
  );
});

test("staleTasks: boundary — age exactly at the budget is not stale", () => {
  const exactlyAt = taskAt("t-exact", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
  ]); // dwell exactly 40 days
  const budget = { OPEN: 40 * DAY };
  assert.deepEqual(staleTasks([exactlyAt], budget, NOW), []);
  // One millisecond past the budget tips it over.
  const past = taskAt("t-past", [
    [
      "PUBLISH",
      "DRAFT",
      "OPEN",
      iso(new Date(NOW.getTime() - 40 * DAY - 1)),
    ],
  ]);
  assert.equal(staleTasks([past], budget, NOW).length, 1);
  // Zero budget: stale the instant any time has passed.
  assert.equal(
    staleTasks([taskAt("t-zero", [["PUBLISH", "DRAFT", "OPEN", daysAgo(1)]])], { OPEN: 0 }, NOW).length,
    1,
  );
});

test("staleTasks: is pure — no mutation, no dispatch, same instances returned", () => {
  const stale = taskAt("t-pure-stale", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
  ]);
  const fresh = taskAt("t-pure-fresh", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(3)],
  ]);
  const staleBefore = JSON.stringify(stale.toJSON());
  const freshBefore = JSON.stringify(fresh.toJSON());

  const found = staleTasks([stale, fresh], BUDGET, NOW);
  assert.equal(found.length, 1);
  assert.ok(found[0] === stale, "returns the original instance, not a copy");

  assert.equal(JSON.stringify(stale.toJSON()), staleBefore);
  assert.equal(JSON.stringify(fresh.toJSON()), freshBefore);
});

test("staleTasks: invalid budget configuration fails fast", () => {
  const task = taskAt("t-cfg", [["PUBLISH", "DRAFT", "OPEN", daysAgo(40)]]);
  assert.throws(
    () => staleTasks([task], { BOGUS: 1000 } as never, NOW),
    /invalid maxAgeByState: unknown state "BOGUS"/,
  );
  assert.throws(
    () => staleTasks([task], { OPEN: -1 }, NOW),
    /invalid maxAgeByState: budget for "OPEN" must be a non-negative finite number/,
  );
  assert.throws(
    () => staleTasks([task], { OPEN: Number.NaN }, NOW),
    /invalid maxAgeByState: budget for "OPEN" must be a non-negative finite number/,
  );
  assert.throws(
    () => staleTasks([task], { OPEN: Number.POSITIVE_INFINITY }, NOW),
    /invalid maxAgeByState: budget for "OPEN" must be a non-negative finite number/,
  );
  assert.throws(
    () => staleTasks([task], { OPEN: "30d" } as never, NOW),
    /invalid maxAgeByState: budget for "OPEN" must be a non-negative finite number/,
  );
  assert.throws(
    () => staleTasks([task], "OPEN=30" as never, NOW),
    /invalid maxAgeByState: expected an object/,
  );
  assert.throws(
    () => staleTasks([task], null as never, NOW),
    /invalid maxAgeByState: expected an object/,
  );
});

test("staleTasks: now parameter and default real clock", () => {
  const task = taskAt("t-clock", [["PUBLISH", "DRAFT", "OPEN", daysAgo(10)]]);
  const budget = { OPEN: 7 * DAY };
  // 10 days old: stale at the pinned NOW...
  assert.equal(staleTasks([task], budget, NOW).length, 1);
  // ...but not stale when viewed from a week after creation.
  const earlier = new Date(task.history[0].at);
  assert.equal(
    staleTasks([task], budget, new Date(earlier.getTime() + 2 * DAY)).length,
    0,
  );
  // Default now is the real clock: a task that entered OPEN an hour ago on
  // the wire is stale under a zero budget without pinning `now`, while a
  // far-future-dated entry is not.
  const anHourAgo = new Date(Date.now() - 3600_000);
  const wireTask = TaskLifecycle.fromHistory("t-wire", [
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: anHourAgo.toISOString(), actor: "system" },
  ]);
  assert.equal(staleTasks([wireTask], { OPEN: 0 }).length, 1);
  const inTheFuture = new Date(Date.now() + 3600_000);
  const futureTask = TaskLifecycle.fromHistory("t-wire-future", [
    { seq: 1, event: "PUBLISH", from: "DRAFT", to: "OPEN", at: inTheFuture.toISOString(), actor: "system" },
  ]);
  assert.equal(staleTasks([futureTask], { OPEN: 0 }).length, 0);
});
