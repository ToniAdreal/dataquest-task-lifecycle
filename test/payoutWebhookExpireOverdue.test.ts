import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  buildPayoutWebhook,
  expireOverdueTasks,
  verifyPayoutWebhook,
} from "../src/index.js";

/**
 * Payout webhook x `expireOverdueTasks` watchdog (backlog #815).
 *
 * `expireOverdueTasks` and `buildPayoutWebhook` only ever met in
 * `demo.test.ts`, where the demo's own fixtures did the work and no
 * test pinned the interaction itself: after the watchdog expires an
 * overdue task, does that task really build no payout webhook, and
 * does a settled PAID task in the same batch stay untouched and
 * still announce its payout? The watchdog result entry is the
 * audit evidence linking the two sides, so it is pinned too.
 *
 * Rules pinned here:
 *  - in a mixed batch (overdue OPEN + PAID + not-overdue OPEN),
 *    the watchdog expires only the overdue task, and its result
 *    carries the EXPIRE audit entry (OPEN -> EXPIRED, `system`
 *    actor) that also sits at the end of the task history
 *  - the expired task builds no payout webhook: the only-PAID
 *    guard refuses it with an explicit non-PAID error
 *  - the PAID task in the same batch is never attempted by the
 *    watchdog (its history is untouched) and its webhook still
 *    builds and verifies
 *  - the not-overdue task is untouched in state and history,
 *    and builds no webhook either (still OPEN, not PAID)
 *  - a PAID task carrying a past deadline for its own PAID state
 *    is still terminal and therefore never attempted, so its
 *    webhook survives a watchdog pass over it
 */

const SECRET = "test-payout-webhook-expire-overdue-secret";
const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

/** Drive a task from DRAFT all the way to PAID. */
function toPaid(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
  return t;
}

function openTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster" });
  assert.equal(t.state, "OPEN");
  return t;
}

test("mixed batch: watchdog expires only the overdue task and its EXPIRE entry is in place", () => {
  const overdue = openTask("task-expire-webhook-overdue");
  overdue.setSlaDeadline(PAST);
  const paid = toPaid("task-expire-webhook-paid");
  const paidHistoryBefore = JSON.stringify(paid.history);
  const notOverdue = openTask("task-expire-webhook-fresh");
  notOverdue.setSlaDeadline(FUTURE);
  const notOverdueHistoryBefore = JSON.stringify(notOverdue.history);

  const results = expireOverdueTasks([overdue, paid, notOverdue], NOW);

  // Only the overdue task is attempted; the settled and the
  // not-overdue tasks never appear in the watchdog outcomes.
  assert.equal(results.length, 1);
  assert.equal(results[0].task.id, overdue.id);
  assert.equal(results[0].expired, true);
  assert.equal(results[0].error, undefined);
  assert.equal(overdue.state, "EXPIRED");

  // The result entry is the EXPIRE audit record, and it is the
  // same record the history now ends with.
  const entry = results[0].entry;
  assert.ok(entry, "successful expiry must carry its audit entry");
  assert.equal(entry.event, "EXPIRE");
  assert.equal(entry.from, "OPEN");
  assert.equal(entry.to, "EXPIRED");
  assert.equal(entry.actor, "system");
  const history = overdue.history;
  assert.deepEqual(history[history.length - 1], entry);

  // Neither other task was touched by the watchdog pass.
  assert.equal(paid.state, "PAID");
  assert.equal(JSON.stringify(paid.history), paidHistoryBefore);
  assert.equal(notOverdue.state, "OPEN");
  assert.equal(JSON.stringify(notOverdue.history), notOverdueHistoryBefore);
});

test("expired task builds no payout webhook; PAID task webhook still builds and verifies", () => {
  const overdue = openTask("task-expire-webhook-refused");
  overdue.setSlaDeadline(PAST);
  const paid = toPaid("task-expire-webhook-announced");

  expireOverdueTasks([overdue, paid], NOW);
  assert.equal(overdue.state, "EXPIRED");
  assert.equal(paid.state, "PAID");

  assert.throws(
    () => buildPayoutWebhook(overdue, SECRET, { eventId: "evt-expired" }),
    /cannot build payout webhook: task task-expire-webhook-refused is in state EXPIRED, only PAID tasks/,
    "an expired task has no completed settlement to announce",
  );

  const { payload, signature } = buildPayoutWebhook(paid, SECRET, {
    eventId: "evt-expire-webhook-paid",
    now: NOW,
  });
  assert.equal(payload.taskId, paid.id);
  assert.equal(payload.event, "PAYOUT_COMPLETE");
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
  assert.equal(
    verifyPayoutWebhook(payload, signature, "wrong-secret"),
    false,
    "the PAID pass is not vacuous: a wrong secret still fails",
  );
});

test("not-overdue task keeps its state and builds no webhook", () => {
  const fresh = openTask("task-expire-webhook-not-overdue");
  fresh.setSlaDeadline(FUTURE);
  const historyBefore = JSON.stringify(fresh.history);

  const results = expireOverdueTasks([fresh], NOW);
  assert.equal(results.length, 0, "nothing overdue, nothing attempted");
  assert.equal(fresh.state, "OPEN");
  assert.equal(JSON.stringify(fresh.history), historyBefore);
  assert.throws(
    () => buildPayoutWebhook(fresh, SECRET, { eventId: "evt-fresh" }),
    /is in state OPEN, only PAID tasks/,
  );
});

test("PAID task with a past deadline for its own state is never attempted and keeps its webhook", () => {
  const paid = toPaid("task-expire-webhook-paid-deadline");
  paid.setSlaDeadline(PAST, "PAID");
  const historyBefore = JSON.stringify(paid.history);

  const results = expireOverdueTasks([paid], NOW);
  assert.equal(results.length, 0, "terminal tasks are never attempted");
  assert.equal(paid.state, "PAID");
  assert.equal(JSON.stringify(paid.history), historyBefore);

  const { payload, signature } = buildPayoutWebhook(paid, SECRET, {
    eventId: "evt-expire-webhook-paid-deadline",
    now: NOW,
  });
  assert.equal(payload.taskId, paid.id);
  assert.equal(verifyPayoutWebhook(payload, signature, SECRET), true);
});

test("expired task cannot reach PAID afterwards, so no webhook can ever follow the expiry", () => {
  const overdue = openTask("task-expire-webhook-terminal");
  overdue.setSlaDeadline(PAST);
  expireOverdueTasks([overdue], NOW);
  assert.equal(overdue.state, "EXPIRED");
  assert.throws(
    () => overdue.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /invalid transition: PAYOUT_COMPLETE from EXPIRED/,
  );
  assert.equal(overdue.state, "EXPIRED");
  assert.throws(
    () => buildPayoutWebhook(overdue, SECRET, { eventId: "evt-terminal" }),
    /is in state EXPIRED, only PAID tasks/,
  );
});
