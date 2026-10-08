/**
 * expireOverdueTasks watchdog executor (#108).
 *
 * `expiredTasks()` is a pure filter, but it has a trap: EXPIRE edges exist
 * only on OPEN/ACCEPTED/CAPTURING/SUBMITTED, so a hand-written `for` loop
 * dispatching EXPIRE aborts the whole batch on the first overdue task that
 * has no EXPIRE edge (e.g. IN_REVIEW). expireOverdueTasks() reports
 * per-task outcomes instead and never lets one unexpirable task block the
 * rest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  ExpireOverdueResult,
  expireOverdueTasks,
  expiredTasks,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function openTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster" });
  return t; // OPEN — has an EXPIRE edge
}

function inReviewTask(id: string): TaskLifecycle {
  const t = openTask(id);
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  return t; // IN_REVIEW — no EXPIRE edge
}

function abandonedTask(id: string): TaskLifecycle {
  const t = openTask(id);
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("ABANDON", { actor: "contributor" });
  return t; // ABANDONED — terminal
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

describe("expireOverdueTasks", () => {
  it("expires a mixed batch with correct per-item outcomes", () => {
    const expirable = openTask("expirable");
    expirable.setSlaDeadline(PAST);

    const stuck = inReviewTask("stuck");
    stuck.setSlaDeadline(PAST);

    const notOverdue = openTask("not-overdue");
    notOverdue.setSlaDeadline(FUTURE);

    const noDeadline = openTask("no-deadline");

    const terminal = abandonedTask("terminal");
    terminal.setSlaDeadline(PAST, "ABANDONED"); // past deadline, but terminal

    const results = expireOverdueTasks(
      [expirable, stuck, notOverdue, noDeadline, terminal],
      NOW,
    );

    // only overdue non-terminal tasks are attempted
    assert.equal(results.length, 2);

    const ok = byId(results, "expirable");
    assert.equal(ok.expired, true);
    assert.equal(ok.error, undefined);
    assert.equal(ok.task.state, "EXPIRED");

    const blocked = byId(results, "stuck");
    assert.equal(blocked.expired, false);
    assert.match(blocked.error ?? "", /invalid transition: EXPIRE from IN_REVIEW/);
    // the failed task is untouched: still IN_REVIEW, no new history
    assert.equal(blocked.task.state, "IN_REVIEW");
  });

  it("does not block the rest of the batch on the first unexpirable task", () => {
    const stuck = inReviewTask("first");
    stuck.setSlaDeadline(PAST);
    const expirable = openTask("second");
    expirable.setSlaDeadline(PAST);

    // unexpirable task deliberately listed FIRST
    const results = expireOverdueTasks([stuck, expirable], NOW);
    assert.equal(results.length, 2);
    assert.equal(byId(results, "first").expired, false);
    assert.equal(byId(results, "second").expired, true);
    assert.equal(byId(results, "second").task.state, "EXPIRED");
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(expireOverdueTasks([], NOW), []);
  });

  it("respects the now parameter", () => {
    const t = openTask("t-time");
    t.setSlaDeadline(new Date("2026-06-01T00:00:00.000Z"));
    assert.equal(
      expireOverdueTasks([t], new Date("2026-05-01T00:00:00.000Z")).length,
      0,
    );
    const results = expireOverdueTasks([t], new Date("2026-07-01T00:00:00.000Z"));
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
  });

  it("leaves failed tasks untouched: state and history unchanged", () => {
    const stuck = inReviewTask("stuck");
    stuck.setSlaDeadline(PAST);
    const before = JSON.stringify(stuck.history);

    const results = expireOverdueTasks([stuck], NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, false);
    assert.equal(stuck.state, "IN_REVIEW");
    assert.equal(JSON.stringify(stuck.history), before);
  });

  it("successful expiry is an auditable dispatch: appends to history with a seq gap", () => {
    const t = openTask("audited");
    t.setSlaDeadline(PAST);
    const historyBefore = t.history.length;

    const results = expireOverdueTasks([t], NOW);
    assert.equal(results[0].expired, true);
    const history = t.history;
    assert.equal(history.length, historyBefore + 1);
    const last = history[history.length - 1];
    assert.equal(last.event, "EXPIRE");
    assert.equal(last.from, "OPEN");
    assert.equal(last.to, "EXPIRED");
    assert.equal(last.seq, historyBefore + 1);
    // hash chain covers the new entry (tamper evidence survives the watchdog)
    assert.match(last.hash ?? "", /^[0-9a-f]{64}$/);
  });

  it("result entries keep batch order and expose the task identity", () => {
    const a = openTask("a");
    a.setSlaDeadline(PAST);
    const b = openTask("b");
    b.setSlaDeadline(PAST);
    const results = expireOverdueTasks([a, b], NOW);
    assert.deepEqual(
      results.map((r) => r.task.id),
      ["a", "b"],
    );
    assert.ok(results.every((r) => r.expired));
  });

  it("pure filter expiredTasks is unchanged: it still selects the unexpirable overdue task", () => {
    const expirable = openTask("expirable");
    expirable.setSlaDeadline(PAST);
    const stuck = inReviewTask("stuck");
    stuck.setSlaDeadline(PAST);

    // the pure filter answers "who is overdue" — IN_REVIEW included…
    assert.deepEqual(
      expiredTasks([expirable, stuck], NOW).map((t) => t.id),
      ["expirable", "stuck"],
    );
    // …while the executor splits the per-task outcome
    const results = expireOverdueTasks([expirable, stuck], NOW);
    assert.deepEqual(
      results.map((r) => r.expired),
      [true, false],
    );
  });
});
