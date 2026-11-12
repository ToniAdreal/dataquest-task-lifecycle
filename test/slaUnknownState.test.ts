import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

function acceptedTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-sla-unknown-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

test("getSlaDeadline: unknown state throws like setSlaDeadline, deadline untouched", () => {
  const t = acceptedTask();
  t.setSlaDeadline(FUTURE); // deadline on the current state (ACCEPTED)
  assert.throws(
    () => t.getSlaDeadline("OPNE" as never),
    /invalid SLA deadline: unknown state OPNE/,
  );
  assert.equal(t.getSlaDeadline("ACCEPTED"), FUTURE.toISOString());
  assert.equal(t.getSlaDeadline(), FUTURE.toISOString());
});

test("clearSlaDeadline: unknown state throws like setSlaDeadline, deadline untouched", () => {
  const t = acceptedTask();
  t.setSlaDeadline(FUTURE);
  assert.throws(
    () => t.clearSlaDeadline("OPNE" as never),
    /invalid SLA deadline: unknown state OPNE/,
  );
  assert.equal(t.getSlaDeadline("ACCEPTED"), FUTURE.toISOString());
  assert.equal(t.history.length, 2); // no history entry: a rejected clear leaves nothing
});

test("clearSlaDeadline: unknown state throws even when no deadline exists", () => {
  const t = acceptedTask();
  assert.throws(
    () => t.clearSlaDeadline("OPNE" as never),
    /invalid SLA deadline: unknown state OPNE/,
  );
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
});

test("getSlaDeadline: state names are case-sensitive, lowercase is unknown", () => {
  const t = acceptedTask();
  t.setSlaDeadline(FUTURE, "OPEN");
  assert.throws(
    () => t.getSlaDeadline("open" as never),
    /invalid SLA deadline: unknown state open/,
  );
  assert.equal(t.getSlaDeadline("OPEN"), FUTURE.toISOString());
});

test("getSlaDeadline: known state without a deadline still returns undefined", () => {
  const t = acceptedTask(); // ACCEPTED, no deadline set
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
});

test("clearSlaDeadline: known state clears only that state's deadline", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST, "OPEN");
  t.setSlaDeadline(FUTURE, "ACCEPTED");
  t.clearSlaDeadline("OPEN");
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
  assert.equal(t.getSlaDeadline("ACCEPTED"), FUTURE.toISOString());
});

test("clearSlaDeadline: no argument still clears every state's deadline", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST, "OPEN");
  t.setSlaDeadline(FUTURE, "ACCEPTED");
  t.clearSlaDeadline();
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
  assert.equal(t.getSlaDeadline(), undefined);
});

test("get/clearSlaDeadline: default (current-state) behavior is unchanged", () => {
  const t = acceptedTask(); // current state ACCEPTED
  t.setSlaDeadline(FUTURE);
  assert.equal(t.getSlaDeadline(), FUTURE.toISOString());
  t.clearSlaDeadline("ACCEPTED");
  assert.equal(t.getSlaDeadline(), undefined);
});

test("setSlaDeadline: unknown state throws the same wording the new guards reuse", () => {
  const t = acceptedTask();
  assert.throws(
    () => t.setSlaDeadline(FUTURE, "OPNE" as never),
    /invalid SLA deadline: unknown state OPNE/,
  );
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
});
