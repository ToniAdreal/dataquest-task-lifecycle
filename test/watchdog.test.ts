import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, expiredTasks, isOverdue } from "../src/index.js";

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");
const NOW = new Date("2026-10-04T00:00:00.000Z");

function acceptedTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

test("expiredTasks: picks only non-terminal overdue tasks from a mixed batch", () => {
  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(PAST); // ACCEPTED, deadline long past

  const notYet = acceptedTask("t-notyet");
  notYet.setSlaDeadline(FUTURE); // deadline far in the future

  const noDeadline = acceptedTask("t-nodeadline");

  const terminal = acceptedTask("t-terminal");
  terminal.dispatch("ABANDON", { actor: "contributor" });
  terminal.setSlaDeadline(PAST, "ABANDONED"); // past deadline, but terminal

  const otherState = acceptedTask("t-otherstate");
  otherState.setSlaDeadline(PAST, "OPEN"); // deadline for a state we left

  const found = expiredTasks([overdue, notYet, noDeadline, terminal, otherState], NOW);
  assert.deepEqual(
    found.map((t) => t.id),
    ["t-overdue"],
  );
});

test("expiredTasks: empty input gives empty output", () => {
  assert.deepEqual(expiredTasks([], NOW), []);
});

test("expiredTasks: respects the now parameter like isOverdue does", () => {
  const t = acceptedTask("t-time");
  t.setSlaDeadline(new Date("2026-06-01T00:00:00.000Z"));
  assert.equal(expiredTasks([t], new Date("2026-05-01T00:00:00.000Z")).length, 0);
  assert.equal(expiredTasks([t], new Date("2026-07-01T00:00:00.000Z")).length, 1);
});

test("expiredTasks: default now is the real clock", () => {
  const t = acceptedTask("t-clock");
  t.setSlaDeadline(PAST);
  assert.equal(expiredTasks([t]).length, 1);
  t.clearSlaDeadline();
  t.setSlaDeadline(FUTURE);
  assert.equal(expiredTasks([t]).length, 0);
});

test("expiredTasks: never mutates — no dispatch, no state change", () => {
  const t = acceptedTask("t-pure");
  t.setSlaDeadline(PAST);
  const before = t.history.length;
  const found = expiredTasks([t], NOW);
  assert.equal(found.length, 1);
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, before);
});

test("expiredTasks: agrees with isOverdue for every task in the batch", () => {
  const tasks = [
    acceptedTask("a"),
    acceptedTask("b"),
    acceptedTask("c"),
  ];
  tasks[0].setSlaDeadline(PAST);
  tasks[1].setSlaDeadline(FUTURE);
  const found = expiredTasks(tasks, NOW);
  for (const t of tasks) {
    assert.equal(found.includes(t), isOverdue(t, NOW));
  }
});

test("expiredTasks: documented watchdog loop expires everything it returns", () => {
  const overdue = acceptedTask("t-watchdog");
  overdue.setSlaDeadline(PAST);
  const paid = acceptedTask("t-paid");
  paid.setSlaDeadline(PAST);

  const found = expiredTasks([overdue, paid], NOW);
  assert.equal(found.length, 2);
  for (const task of found) task.dispatch("EXPIRE", { actor: "system" });
  assert.equal(overdue.state, "EXPIRED");
  assert.equal(paid.state, "EXPIRED");
  assert.equal(overdue.history[overdue.history.length - 1].event, "EXPIRE");
  assert.equal(expiredTasks([overdue, paid], NOW).length, 0); // now terminal, no longer picked
});
