import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, nextSlaDeadline } from "../src/index.js";

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

test("nextSlaDeadline: mixed batch picks the earliest future current-state deadline", () => {
  const later = acceptedTask("t-later");
  later.setSlaDeadline(deadlineAt(5 * HOUR));

  const earliest = acceptedTask("t-earliest");
  earliest.setSlaDeadline(deadlineAt(2 * HOUR));

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR));

  const noDeadline = acceptedTask("t-nodeadline");

  const terminal = acceptedTask("t-terminal");
  terminal.dispatch("ABANDON", { actor: "contributor" });
  terminal.setSlaDeadline(deadlineAt(HOUR), "ABANDONED"); // earliest of all, but terminal

  const otherState = acceptedTask("t-otherstate");
  otherState.setSlaDeadline(deadlineAt(HOUR), "OPEN"); // earliest of all, but a left state

  const next = nextSlaDeadline(
    [later, earliest, overdue, noDeadline, terminal, otherState],
    NOW,
  );
  assert.ok(next);
  assert.equal(next.task.id, "t-earliest");
  assert.equal(next.deadline, deadlineAt(2 * HOUR).toISOString());
});

test("nextSlaDeadline: a deadline on a left state never counts, even when it is the earliest", () => {
  const leftStateOnly = acceptedTask("t-leftstate");
  leftStateOnly.setSlaDeadline(deadlineAt(HOUR), "OPEN"); // task is ACCEPTED now

  assert.equal(nextSlaDeadline([leftStateOnly], NOW), undefined);

  const currentState = acceptedTask("t-current");
  currentState.setSlaDeadline(deadlineAt(2 * HOUR)); // ACCEPTED deadline
  const next = nextSlaDeadline([leftStateOnly, currentState], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-current");
});

test("nextSlaDeadline: deadline exactly at now is overdue, not next", () => {
  const atNow = acceptedTask("t-atnow");
  atNow.setSlaDeadline(NOW);

  const future = acceptedTask("t-future");
  future.setSlaDeadline(deadlineAt(HOUR));

  assert.equal(nextSlaDeadline([atNow], NOW), undefined);
  const next = nextSlaDeadline([atNow, future], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-future");
});

test("nextSlaDeadline: ties keep input order", () => {
  const first = acceptedTask("t-first");
  first.setSlaDeadline(deadlineAt(2 * HOUR));
  const second = acceptedTask("t-second");
  second.setSlaDeadline(deadlineAt(2 * HOUR));
  const third = acceptedTask("t-third");
  third.setSlaDeadline(deadlineAt(2 * HOUR));

  const next = nextSlaDeadline([third, first, second], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-third");
});

test("nextSlaDeadline: empty input and no-candidate batches return undefined", () => {
  assert.equal(nextSlaDeadline([], NOW), undefined);

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR));
  const noDeadline = acceptedTask("t-nodeadline");
  assert.equal(nextSlaDeadline([overdue, noDeadline], NOW), undefined);
});

test("nextSlaDeadline: invalid now fails fast", () => {
  const task = acceptedTask("t-task");
  task.setSlaDeadline(deadlineAt(HOUR));
  assert.throws(
    () => nextSlaDeadline([task], new Date("not-a-date")),
    /invalid now: expected a valid Date/,
  );
});

test("nextSlaDeadline: pure — inputs unchanged, returned task is the same object", () => {
  const a = acceptedTask("t-a");
  a.setSlaDeadline(deadlineAt(3 * HOUR));
  const b = acceptedTask("t-b");
  b.setSlaDeadline(deadlineAt(HOUR));
  const beforeA = JSON.stringify(a.toJSON());
  const beforeB = JSON.stringify(b.toJSON());

  const next = nextSlaDeadline([a, b], NOW);
  assert.ok(next);
  assert.equal(next.task, b);
  assert.equal(next.deadline, b.getSlaDeadline(b.state));
  assert.equal(JSON.stringify(a.toJSON()), beforeA);
  assert.equal(JSON.stringify(b.toJSON()), beforeB);
  assert.equal(a.state, "ACCEPTED");
  assert.equal(b.state, "ACCEPTED");
});

test("nextSlaDeadline: fixed now gives the same answer on repeat runs", () => {
  const a = acceptedTask("t-a");
  a.setSlaDeadline(deadlineAt(4 * HOUR));
  const b = acceptedTask("t-b");
  b.setSlaDeadline(deadlineAt(2 * HOUR));
  const first = nextSlaDeadline([a, b], NOW);
  const second = nextSlaDeadline([a, b], NOW);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.task.id, second.task.id);
  assert.equal(first.deadline, second.deadline);
});

test("nextSlaDeadline: a state change retires the old state's deadline", () => {
  const task = acceptedTask("t-moving");
  task.setSlaDeadline(deadlineAt(HOUR)); // ACCEPTED deadline
  task.dispatch("START_CAPTURE", { actor: "contributor" }); // now CAPTURING
  // The ACCEPTED deadline no longer counts; nothing is set for CAPTURING.
  assert.equal(nextSlaDeadline([task], NOW), undefined);

  task.setSlaDeadline(deadlineAt(3 * HOUR)); // CAPTURING deadline
  const next = nextSlaDeadline([task], NOW);
  assert.ok(next);
  assert.equal(next.deadline, deadlineAt(3 * HOUR).toISOString());
});
