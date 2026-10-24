import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksApproachingDeadline } from "../src/index.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR = 3600_000;

function acceptedTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

function deadlineAt(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

test("tasksApproachingDeadline: picks only non-terminal tasks with a deadline inside the window", () => {
  const inside = acceptedTask("t-inside");
  inside.setSlaDeadline(deadlineAt(2 * HOUR)); // 2h out, inside a 24h window

  const outside = acceptedTask("t-outside");
  outside.setSlaDeadline(deadlineAt(48 * HOUR)); // beyond the window

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR)); // already past: expiredTasks' job

  const noDeadline = acceptedTask("t-nodeadline");

  const terminal = acceptedTask("t-terminal");
  terminal.dispatch("ABANDON", { actor: "contributor" });
  terminal.setSlaDeadline(deadlineAt(2 * HOUR), "ABANDONED"); // in-window, but terminal

  const otherState = acceptedTask("t-otherstate");
  otherState.setSlaDeadline(deadlineAt(2 * HOUR), "OPEN"); // deadline for a state we left

  const found = tasksApproachingDeadline(
    [inside, outside, overdue, noDeadline, terminal, otherState],
    24 * HOUR,
    NOW,
  );
  assert.deepEqual(
    found.map((t) => t.id),
    ["t-inside"],
  );
});

test("tasksApproachingDeadline: window bounds are (now, now+withinMs]", () => {
  const atNow = acceptedTask("t-atnow");
  atNow.setSlaDeadline(NOW); // deadline == now: overdue, not approaching

  const atEdge = acceptedTask("t-atedge");
  atEdge.setSlaDeadline(deadlineAt(24 * HOUR)); // exactly at the window edge: included

  const justPastEdge = acceptedTask("t-pastedge");
  justPastEdge.setSlaDeadline(deadlineAt(24 * HOUR + 1)); // 1ms past the edge: excluded

  const found = tasksApproachingDeadline(
    [atNow, atEdge, justPastEdge],
    24 * HOUR,
    NOW,
  );
  assert.deepEqual(
    found.map((t) => t.id),
    ["t-atedge"],
  );
});

test("tasksApproachingDeadline: withinMs 0 selects nothing", () => {
  const future = acceptedTask("t-future");
  future.setSlaDeadline(deadlineAt(HOUR));
  const atNow = acceptedTask("t-atnow");
  atNow.setSlaDeadline(NOW);
  assert.deepEqual(tasksApproachingDeadline([future, atNow], 0, NOW), []);
});

test("tasksApproachingDeadline: empty input gives empty output", () => {
  assert.deepEqual(tasksApproachingDeadline([], 24 * HOUR, NOW), []);
});

test("tasksApproachingDeadline: respects the now parameter", () => {
  const t = acceptedTask("t-time");
  t.setSlaDeadline(deadlineAt(12 * HOUR));
  // At NOW the deadline is 12h out: inside a 24h window, outside a 6h one.
  assert.equal(tasksApproachingDeadline([t], 24 * HOUR, NOW).length, 1);
  assert.equal(tasksApproachingDeadline([t], 6 * HOUR, NOW).length, 0);
  // 13h later the deadline is past: approaching no longer reports it.
  const later = new Date(NOW.getTime() + 13 * HOUR);
  assert.equal(tasksApproachingDeadline([t], 24 * HOUR, later).length, 0);
});

test("tasksApproachingDeadline: default now is the real clock", () => {
  const future = acceptedTask("t-future");
  future.setSlaDeadline(new Date("2099-01-01T00:00:00.000Z"));
  const past = acceptedTask("t-past");
  past.setSlaDeadline(new Date("2020-01-01T00:00:00.000Z"));
  // A window reaching to 2099 covers the future deadline from today;
  // the past deadline is overdue, never approaching.
  const centuryMs = 100 * 365 * 24 * HOUR;
  assert.deepEqual(
    tasksApproachingDeadline([future, past], centuryMs).map((t) => t.id),
    ["t-future"],
  );
});

test("tasksApproachingDeadline: never mutates and returns the same task objects", () => {
  const t = acceptedTask("t-pure");
  t.setSlaDeadline(deadlineAt(2 * HOUR));
  const beforeHistory = t.history.length;
  const found = tasksApproachingDeadline([t], 24 * HOUR, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0], t);
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, beforeHistory);
});

test("tasksApproachingDeadline: invalid withinMs fails fast", () => {
  const t = acceptedTask("t-x");
  t.setSlaDeadline(deadlineAt(HOUR));
  for (const bad of [-1, Number.NaN, Infinity, "1000" as unknown as number]) {
    assert.throws(
      () => tasksApproachingDeadline([t], bad, NOW),
      /invalid tasksApproachingDeadline: withinMs must be a non-negative finite number of milliseconds/,
    );
  }
});

test("tasksApproachingDeadline: invalid now fails fast", () => {
  const t = acceptedTask("t-x");
  t.setSlaDeadline(deadlineAt(HOUR));
  assert.throws(
    () => tasksApproachingDeadline([t], 24 * HOUR, new Date("not-a-date")),
    /invalid now: expected a valid Date/,
  );
});
