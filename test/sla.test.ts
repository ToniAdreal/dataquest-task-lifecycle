import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, isOverdue } from "../src/index.js";

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

function acceptedTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-sla-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

test("isOverdue: false before the deadline", () => {
  const t = acceptedTask();
  t.setSlaDeadline(FUTURE);
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), false);
});

test("isOverdue: true after the deadline", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST);
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), true);
});

test("isOverdue: true exactly at the deadline (inclusive boundary)", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST);
  assert.equal(isOverdue(t, PAST), true);
});

test("isOverdue: false when no deadline is set", () => {
  const t = acceptedTask();
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), false);
});

test("isOverdue: false in a terminal state even past deadline", () => {
  const t = acceptedTask();
  t.dispatch("ABANDON", { actor: "contributor" });
  t.setSlaDeadline(PAST, "ABANDONED");
  assert.equal(t.state, "ABANDONED");
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), false);
});

test("isOverdue: default now is the real clock", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST);
  assert.equal(isOverdue(t), true); // now is 2026, deadline is 2020
  t.clearSlaDeadline();
  t.setSlaDeadline(FUTURE);
  assert.equal(isOverdue(t), false);
});

test("deadline is per-state: another state's deadline is ignored", () => {
  const t = acceptedTask(); // ACCEPTED
  t.setSlaDeadline(PAST, "OPEN"); // deadline for a state we're no longer in
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), false);
  assert.equal(t.getSlaDeadline("OPEN"), PAST.toISOString());
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
});

test("setSlaDeadline: overwrites, stores normalized ISO, clears", () => {
  const t = acceptedTask();
  t.setSlaDeadline("2020-06-01 00:00:00 UTC"); // non-ISO input, still parseable
  assert.equal(t.getSlaDeadline(), "2020-06-01T00:00:00.000Z");
  t.setSlaDeadline(FUTURE);
  assert.equal(t.getSlaDeadline(), FUTURE.toISOString());
  t.clearSlaDeadline();
  assert.equal(t.getSlaDeadline(), undefined);
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), false);
});

test("setSlaDeadline: rejects unparseable input", () => {
  const t = acceptedTask();
  assert.throws(() => t.setSlaDeadline("not-a-date"), /invalid SLA deadline/);
  assert.equal(t.getSlaDeadline(), undefined);
});

test("SLA deadline never transitions the task by itself", () => {
  const t = acceptedTask();
  t.setSlaDeadline(PAST);
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, 2); // PUBLISH + ACCEPT only; no auto-event
  assert.equal(isOverdue(t, new Date("2026-10-04T00:00:00.000Z")), true);
  // Expiry stays explicit: a watchdog dispatches EXPIRE.
  t.dispatch("EXPIRE", { actor: "system" });
  assert.equal(t.state, "EXPIRED");
});
