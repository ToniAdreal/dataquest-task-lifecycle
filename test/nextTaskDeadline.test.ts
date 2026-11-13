import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expiredTasks,
  nextSlaDeadline,
  nextTaskDeadline,
  tasksApproachingDeadline,
} from "../src/index.js";

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

test("nextTaskDeadline: mixed batch picks the earliest future deadline across the whole map", () => {
  const later = acceptedTask("t-later");
  later.setSlaDeadline(deadlineAt(5 * HOUR));

  const earliest = acceptedTask("t-earliest");
  // The winning deadline is for a state the task has not reached yet:
  // the whole-map scan reports it, with the state named.
  earliest.setSlaDeadline(deadlineAt(2 * HOUR), "IN_REVIEW");

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR));

  const noDeadline = acceptedTask("t-nodeadline");

  const terminal = acceptedTask("t-terminal");
  terminal.dispatch("ABANDON", { actor: "contributor" });
  terminal.setSlaDeadline(deadlineAt(HOUR), "ABANDONED"); // earliest of all, but terminal

  const leftStateLater = acceptedTask("t-leftstate");
  leftStateLater.setSlaDeadline(deadlineAt(3 * HOUR), "OPEN"); // left state, later than the winner

  const next = nextTaskDeadline(
    [later, earliest, overdue, noDeadline, terminal, leftStateLater],
    NOW,
  );
  assert.ok(next);
  assert.equal(next.task.id, "t-earliest");
  assert.equal(next.state, "IN_REVIEW");
  assert.equal(next.deadline, deadlineAt(2 * HOUR).toISOString());
});

test("nextTaskDeadline: same task, multi-state deadlines take the earliest state", () => {
  const task = acceptedTask("t-multi");
  task.setSlaDeadline(deadlineAt(5 * HOUR)); // ACCEPTED, current state
  task.setSlaDeadline(deadlineAt(2 * HOUR), "IN_REVIEW"); // earliest
  task.setSlaDeadline(deadlineAt(3 * HOUR), "APPROVED");

  const next = nextTaskDeadline([task], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-multi");
  assert.equal(next.state, "IN_REVIEW");
  assert.equal(next.deadline, deadlineAt(2 * HOUR).toISOString());
  // The winning state is not the task's current state — that is the
  // point of the `state` field.
  assert.notEqual(next.state, task.state);
});

test("nextTaskDeadline: a deadline on a left state counts here, unlike nextSlaDeadline", () => {
  const leftStateOnly = acceptedTask("t-leftstate");
  leftStateOnly.setSlaDeadline(deadlineAt(HOUR), "OPEN"); // task is ACCEPTED now

  // The whole-map scan reports the only deadline in the map, and names
  // the state it belongs to. This is the deliberate difference from
  // nextSlaDeadline, which reads only the current state's deadline.
  const next = nextTaskDeadline([leftStateOnly], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-leftstate");
  assert.equal(next.state, "OPEN");
  assert.equal(next.deadline, deadlineAt(HOUR).toISOString());

  assert.equal(nextSlaDeadline([leftStateOnly], NOW), undefined);
});

test("nextTaskDeadline: deadlines attached to terminal states never count", () => {
  const terminalOnly = acceptedTask("t-terminalonly");
  terminalOnly.setSlaDeadline(deadlineAt(HOUR), "PAID"); // earliest of all, but a terminal state
  assert.equal(nextTaskDeadline([terminalOnly], NOW), undefined);

  const live = acceptedTask("t-live");
  live.setSlaDeadline(deadlineAt(3 * HOUR)); // ACCEPTED deadline, current state
  const next = nextTaskDeadline([terminalOnly, live], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-live");
  assert.equal(next.state, "ACCEPTED");

  // A terminal task never qualifies either, even with a future
  // deadline on its own terminal state.
  const paid = acceptedTask("t-paid");
  paid.dispatch("START_CAPTURE", { actor: "contributor" });
  paid.dispatch("SUBMIT", { actor: "contributor" });
  paid.dispatch("BEGIN_REVIEW", { actor: "researcher" });
  paid.dispatch("APPROVE", { actor: "researcher" });
  paid.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  paid.dispatch("PAYOUT_COMPLETE", { actor: "contributor" });
  paid.setSlaDeadline(deadlineAt(HOUR), "PAID");
  assert.equal(nextTaskDeadline([paid], NOW), undefined);
});

test("nextTaskDeadline: empty input and no-candidate batches return undefined", () => {
  assert.equal(nextTaskDeadline([], NOW), undefined);

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR));
  const noDeadline = acceptedTask("t-nodeadline");
  assert.equal(nextTaskDeadline([overdue, noDeadline], NOW), undefined);

  // All deadlines expired, across several states at once.
  const allExpired = acceptedTask("t-allexpired");
  allExpired.setSlaDeadline(deadlineAt(-3 * HOUR));
  allExpired.setSlaDeadline(deadlineAt(-HOUR), "IN_REVIEW");
  allExpired.setSlaDeadline(deadlineAt(-2 * HOUR), "APPROVED");
  assert.equal(nextTaskDeadline([allExpired], NOW), undefined);
});

test("nextTaskDeadline: deadline exactly at now is overdue, not next", () => {
  const atNow = acceptedTask("t-atnow");
  atNow.setSlaDeadline(NOW);

  const future = acceptedTask("t-future");
  future.setSlaDeadline(deadlineAt(HOUR));

  assert.equal(nextTaskDeadline([atNow], NOW), undefined);
  const next = nextTaskDeadline([atNow, future], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-future");
});

test("nextTaskDeadline: ties across tasks keep input order", () => {
  const first = acceptedTask("t-first");
  first.setSlaDeadline(deadlineAt(2 * HOUR));
  const second = acceptedTask("t-second");
  second.setSlaDeadline(deadlineAt(2 * HOUR));
  const third = acceptedTask("t-third");
  third.setSlaDeadline(deadlineAt(2 * HOUR));

  const next = nextTaskDeadline([third, first, second], NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-third");
  assert.equal(next.state, "ACCEPTED");
});

test("nextTaskDeadline: ties within one task keep transition-table declaration order", () => {
  const task = acceptedTask("t-tie");
  task.setSlaDeadline(deadlineAt(2 * HOUR), "IN_REVIEW");
  task.setSlaDeadline(deadlineAt(2 * HOUR)); // ACCEPTED, current state

  // ACCEPTED precedes IN_REVIEW in the transition table, so it wins
  // the same-instant tie even though it was set second.
  const next = nextTaskDeadline([task], NOW);
  assert.ok(next);
  assert.equal(next.state, "ACCEPTED");
  assert.equal(next.deadline, deadlineAt(2 * HOUR).toISOString());
});

test("nextTaskDeadline: invalid now fails fast", () => {
  const task = acceptedTask("t-task");
  task.setSlaDeadline(deadlineAt(HOUR));
  assert.throws(
    () => nextTaskDeadline([task], new Date("not-a-date")),
    /invalid now: expected a valid Date/,
  );
});

test("nextTaskDeadline: pure — inputs unchanged, returned task is the same object", () => {
  const a = acceptedTask("t-a");
  a.setSlaDeadline(deadlineAt(3 * HOUR));
  a.setSlaDeadline(deadlineAt(4 * HOUR), "IN_REVIEW");
  const b = acceptedTask("t-b");
  b.setSlaDeadline(deadlineAt(HOUR));
  const beforeA = JSON.stringify(a.toJSON());
  const beforeB = JSON.stringify(b.toJSON());

  const next = nextTaskDeadline([a, b], NOW);
  assert.ok(next);
  assert.equal(next.task, b);
  assert.equal(next.state, "ACCEPTED");
  assert.equal(next.deadline, b.getSlaDeadline(b.state));
  assert.equal(JSON.stringify(a.toJSON()), beforeA);
  assert.equal(JSON.stringify(b.toJSON()), beforeB);
  assert.equal(a.state, "ACCEPTED");
  assert.equal(b.state, "ACCEPTED");
});

test("nextTaskDeadline: agrees with the watchdog screens on the same batch", () => {
  const winner = acceptedTask("t-winner");
  winner.setSlaDeadline(deadlineAt(2 * HOUR)); // current-state deadline, earliest
  winner.setSlaDeadline(deadlineAt(9 * HOUR), "IN_REVIEW"); // later, does not change the pick

  const later = acceptedTask("t-later");
  later.setSlaDeadline(deadlineAt(5 * HOUR));

  const overdue = acceptedTask("t-overdue");
  overdue.setSlaDeadline(deadlineAt(-HOUR));

  const noDeadline = acceptedTask("t-nodeadline");
  const batch = [later, winner, overdue, noDeadline];

  const next = nextTaskDeadline(batch, NOW);
  assert.ok(next);
  assert.equal(next.task.id, "t-winner");
  assert.equal(next.state, "ACCEPTED");

  // The winning task is inside the approaching window, and the overdue
  // task is owned by expiredTasks, not by either helper here.
  const approaching = tasksApproachingDeadline(batch, 24 * HOUR, NOW);
  assert.ok(approaching.some((t) => t.id === "t-winner"));
  const expired = expiredTasks(batch, NOW);
  assert.ok(expired.some((t) => t.id === "t-overdue"));
  assert.ok(!expired.some((t) => t.id === "t-winner"));

  // When the winner is the current-state deadline, nextSlaDeadline
  // agrees on the task and the deadline.
  const slaNext = nextSlaDeadline(batch, NOW);
  assert.ok(slaNext);
  assert.equal(slaNext.task.id, next.task.id);
  assert.equal(slaNext.deadline, next.deadline);
  assert.equal(next.state, next.task.state);
});

test("nextTaskDeadline: fixed now gives the same answer on repeat runs", () => {
  const a = acceptedTask("t-a");
  a.setSlaDeadline(deadlineAt(4 * HOUR));
  const b = acceptedTask("t-b");
  b.setSlaDeadline(deadlineAt(2 * HOUR), "IN_REVIEW");
  const first = nextTaskDeadline([a, b], NOW);
  const second = nextTaskDeadline([a, b], NOW);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.task.id, second.task.id);
  assert.equal(first.state, second.state);
  assert.equal(first.deadline, second.deadline);
});

test("nextTaskDeadline: a state change does not retire other states' deadlines from the map scan", () => {
  const task = acceptedTask("t-moving");
  task.setSlaDeadline(deadlineAt(HOUR)); // ACCEPTED deadline
  task.setSlaDeadline(deadlineAt(3 * HOUR), "IN_REVIEW");
  task.dispatch("START_CAPTURE", { actor: "contributor" }); // now CAPTURING
  // The ACCEPTED deadline still counts — the scan is map-wide, not
  // current-state-only — while nextSlaDeadline sees nothing for
  // CAPTURING.
  const next = nextTaskDeadline([task], NOW);
  assert.ok(next);
  assert.equal(next.state, "ACCEPTED");
  assert.equal(next.deadline, deadlineAt(HOUR).toISOString());
  assert.equal(nextSlaDeadline([task], NOW), undefined);

  task.setSlaDeadline(deadlineAt(30 * 60_000)); // CAPTURING deadline, now earliest
  const moved = nextTaskDeadline([task], NOW);
  assert.ok(moved);
  assert.equal(moved.state, "CAPTURING");
  assert.equal(moved.deadline, deadlineAt(30 * 60_000).toISOString());
});
