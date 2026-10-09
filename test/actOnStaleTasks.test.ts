/**
 * actOnStaleTasks watchdog executor (#127).
 *
 * `staleTasks()` is a pure filter, but it has a trap: ABANDON edges exist
 * only on ACCEPTED/CAPTURING, so a hand-written `for` loop dispatching the
 * default ABANDON action aborts the whole batch on the first stale task
 * that has no ABANDON edge (e.g. SUBMITTED). actOnStaleTasks() reports
 * per-task outcomes instead and never lets one unactionable task block
 * the rest; callers may also pass a custom (e.g. notify-only) action.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
  verifyHistoryChain,
} from "../src/index.js";
import type {
  StaleActionResult,
  TaskEvent,
  TaskHistoryEntry,
  TaskState,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/** Deterministic task builder, same pattern as staleTasks.test.ts. */
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

function capturingStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(15)], // 15d > 7d
  ]);
}

function submittedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(20)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(12)], // 12d > 7d, no ABANDON edge
  ]);
}

const BUDGET = {
  ACCEPTED: 7 * DAY,
  CAPTURING: 7 * DAY,
  SUBMITTED: 7 * DAY,
  OPEN: 30 * DAY,
  IN_REVIEW: 7 * DAY,
};

function byId(results: StaleActionResult[], id: string): StaleActionResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

test("actOnStaleTasks: mixed batch — default ABANDON acts where legal, reports where not", () => {
  const accepted = acceptedStale("t-accepted");
  const submitted = submittedStale("t-submitted");
  const fresh = taskAt("t-fresh", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(1)], // 1d < 7d: not stale
  ]);
  const terminal = taskAt("t-terminal", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(35)],
    ["ABANDON", "ACCEPTED", "ABANDONED", daysAgo(34)], // terminal: never stale
  ]);

  const results = actOnStaleTasks(
    [accepted, submitted, fresh, terminal],
    undefined,
    BUDGET,
    NOW,
  );

  // only the two stale non-terminal tasks are attempted
  assert.equal(results.length, 2);

  const ok = byId(results, "t-accepted");
  assert.equal(ok.acted, true);
  assert.equal(ok.error, undefined);
  assert.equal(ok.task.state, "ABANDONED");

  const blocked = byId(results, "t-submitted");
  assert.equal(blocked.acted, false);
  assert.match(
    blocked.error ?? "",
    /invalid transition: ABANDON from SUBMITTED/,
  );
  assert.equal(blocked.task.state, "SUBMITTED");

  // non-stale / terminal tasks are untouched
  assert.equal(fresh.state, "ACCEPTED");
  assert.equal(terminal.state, "ABANDONED");
});

test("actOnStaleTasks: a failing first task does not block the rest of the batch", () => {
  const stuck = submittedStale("t-first");
  const actionable = capturingStale("t-second");

  const results = actOnStaleTasks([stuck, actionable], undefined, BUDGET, NOW);
  assert.equal(results.length, 2);
  assert.equal(byId(results, "t-first").acted, false);
  assert.equal(byId(results, "t-second").acted, true);
  assert.equal(actionable.state, "ABANDONED");
});

test("actOnStaleTasks: failed tasks are left untouched — state and history unchanged", () => {
  const stuck = submittedStale("t-stuck");
  const before = JSON.stringify(stuck.history);

  const results = actOnStaleTasks([stuck], undefined, BUDGET, NOW);
  assert.equal(results[0].acted, false);
  assert.equal(stuck.state, "SUBMITTED");
  assert.equal(JSON.stringify(stuck.history), before);
});

test("actOnStaleTasks: custom notify-only action is called and does not transition", () => {
  const accepted = acceptedStale("t-notify-a");
  const submitted = submittedStale("t-notify-b");
  const paged: string[] = [];

  const results = actOnStaleTasks(
    [accepted, submitted],
    (t) => {
      paged.push(t.id);
    },
    BUDGET,
    NOW,
  );

  assert.deepEqual(paged, ["t-notify-a", "t-notify-b"]);
  assert.ok(results.every((r) => r.acted));
  // notify-only: no dispatch happened, states and histories unchanged
  assert.equal(accepted.state, "ACCEPTED");
  assert.equal(submitted.state, "SUBMITTED");
  assert.equal(accepted.history.length, 2);
  assert.equal(submitted.history.length, 4);
});

test("actOnStaleTasks: a throwing custom action is isolated per task", () => {
  const a = acceptedStale("t-throw-a");
  const b = acceptedStale("t-throw-b");
  const seen: string[] = [];

  const results = actOnStaleTasks(
    [a, b],
    (t) => {
      seen.push(t.id);
      if (t.id === "t-throw-a") throw "page failed"; // non-Error throw
    },
    BUDGET,
    NOW,
  );

  assert.deepEqual(seen, ["t-throw-a", "t-throw-b"]); // batch kept going
  assert.equal(byId(results, "t-throw-a").acted, false);
  assert.equal(byId(results, "t-throw-a").error, "page failed");
  assert.equal(byId(results, "t-throw-b").acted, true);
});

test("actOnStaleTasks: invalid maxAgeByState fails fast before any action runs", () => {
  const task = acceptedStale("t-cfg");
  let calls = 0;
  const spy = () => {
    calls += 1;
  };
  assert.throws(
    () => actOnStaleTasks([task], spy, { BOGUS: 1000 } as never, NOW),
    /invalid maxAgeByState: unknown state "BOGUS"/,
  );
  assert.throws(
    () => actOnStaleTasks([task], spy, { ACCEPTED: -1 }, NOW),
    /invalid maxAgeByState: budget for "ACCEPTED" must be a non-negative finite number/,
  );
  assert.equal(calls, 0);
  assert.equal(task.state, "ACCEPTED");
  assert.equal(task.history.length, 2);
});

test("actOnStaleTasks: a non-function action fails fast and touches nothing", () => {
  const task = acceptedStale("t-bad-action");
  assert.throws(
    () => actOnStaleTasks([task], "ABANDON" as never, BUDGET, NOW),
    /invalid action: expected a function/,
  );
  assert.equal(task.state, "ACCEPTED");
  assert.equal(task.history.length, 2);
});

test("actOnStaleTasks: an invalid now fails fast before any action runs", () => {
  const task = acceptedStale("t-bad-now");
  let calls = 0;
  assert.throws(
    () =>
      actOnStaleTasks(
        [task],
        () => {
          calls += 1;
        },
        BUDGET,
        new Date("not a date"),
      ),
    /invalid now: expected a valid Date/,
  );
  assert.equal(calls, 0);
  assert.equal(task.state, "ACCEPTED");
});

test("actOnStaleTasks: now is injectable — the same task is fresh earlier, stale later", () => {
  const task = acceptedStale("t-clock"); // entered ACCEPTED 20d before NOW
  const earlier = new Date(NOW.getTime() - 15 * DAY); // dwell then: 5d < 7d
  assert.deepEqual(actOnStaleTasks([task], undefined, BUDGET, earlier), []);
  assert.equal(task.state, "ACCEPTED"); // untouched by the empty run

  const results = actOnStaleTasks([task], undefined, BUDGET, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(task.state, "ABANDONED");
});

test("actOnStaleTasks: empty input, non-stale tasks, and unbudgeted states produce no entries", () => {
  assert.deepEqual(actOnStaleTasks([], undefined, BUDGET, NOW), []);
  const accepted = acceptedStale("t-unbudgeted");
  // no ACCEPTED budget -> never stale -> never attempted
  assert.deepEqual(actOnStaleTasks([accepted], undefined, { OPEN: 1 }, NOW), []);
  assert.equal(accepted.state, "ACCEPTED");
});

test("actOnStaleTasks: the default action is an auditable dispatch by actor \"system\"", () => {
  const t = new TaskLifecycle("t-live");
  t.dispatch("PUBLISH", { actor: "poster" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  const historyBefore = t.history.length;

  const results = actOnStaleTasks(
    [t],
    undefined,
    { ACCEPTED: 0 },
    new Date(Date.now() + 1000),
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].acted, true);
  assert.equal(t.state, "ABANDONED");
  const history = t.history;
  assert.equal(history.length, historyBefore + 1);
  const last = history[history.length - 1];
  assert.equal(last.event, "ABANDON");
  assert.equal(last.from, "ACCEPTED");
  assert.equal(last.to, "ABANDONED");
  assert.equal(last.actor, "system");
  assert.equal(last.seq, historyBefore + 1);
  assert.equal(verifyHistoryChain(history), true);
});

test("actOnStaleTasks: result entries keep batch order", () => {
  const b = capturingStale("t-order-b");
  const a = acceptedStale("t-order-a");
  const c = submittedStale("t-order-c");
  const results = actOnStaleTasks([b, a, c], undefined, BUDGET, NOW);
  assert.deepEqual(
    results.map((r) => r.task.id),
    ["t-order-b", "t-order-a", "t-order-c"],
  );
  assert.deepEqual(
    results.map((r) => r.acted),
    [true, true, false],
  );
});
