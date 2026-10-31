/**
 * expireOverdueTasks x subscribe combination (backlog #748).
 *
 * `expireOverdueTasks()` drives a `dispatch("EXPIRE", { actor: "system" })`
 * per overdue task, and `subscribe()` promises a notification after every
 * successful dispatch. Each half has its own tests
 * (`expireOverdueTasks.test.ts` pins the per-task executor,
 * `subscribe.test.ts` pins the notification contract), but the
 * combination was untested: a watchdog-driven batch expiry must notify
 * the expired task's listeners exactly once with the EXPIRE audit entry,
 * a failure-isolated task must notify nobody while the rest of the batch
 * still expires, and an unsubscribed listener must stay silent while the
 * executor still expires the task. This is the expiry counterpart of the
 * stale-action combination (#732) and the escrow-side symmetry (#739),
 * with a different first half — its conclusions are pinned here, not
 * borrowed from either.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
} from "../src/index.js";
import type {
  ExpireOverdueResult,
  TaskEvent,
  TaskHistoryEntry,
  TaskState,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

type Call = [TaskEvent, TaskState, TaskState, TaskHistoryEntry];

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

function collect(task: TaskLifecycle): { calls: Call[]; unsub: () => void } {
  const calls: Call[] = [];
  const unsub = task.subscribe((event, from, to, entry) => {
    calls.push([event, from, to, entry]);
  });
  return { calls, unsub };
}

function byId(results: ExpireOverdueResult[], id: string): ExpireOverdueResult {
  const found = results.find((r) => r.task.id === id);
  assert.ok(found, `expected a result entry for task ${id}`);
  return found;
}

test("expireOverdueSubscribe: successful expiry notifies exactly once with the audit entry", () => {
  const t = openTask("t-notified");
  t.setSlaDeadline(PAST);
  const { calls } = collect(t);

  const [result] = expireOverdueTasks([t], NOW);

  assert.equal(result.expired, true);
  assert.equal(result.error, undefined);
  assert.equal(t.state, "EXPIRED");
  assert.equal(t.history.length, 2);
  assert.equal(calls.length, 1);
  const [event, from, to, entry] = calls[0];
  assert.equal(event, "EXPIRE");
  assert.equal(from, "OPEN");
  assert.equal(to, "EXPIRED");
  assert.equal(entry.event, "EXPIRE");
  assert.equal(entry.from, "OPEN");
  assert.equal(entry.to, "EXPIRED");
  assert.equal(entry.actor, "system");
  assert.equal(entry.seq, 2);
  // Delivered entry is the appended audit entry, frozen like the
  // history copy, and matches the executor's reported entry.
  assert.ok(Object.isFrozen(entry));
  assert.deepEqual({ ...entry }, { ...t.history[t.history.length - 1] });
  assert.deepEqual({ ...entry }, { ...(result.entry as TaskHistoryEntry) });
});

test("expireOverdueSubscribe: batch notifies only the attempted tasks, each once", () => {
  const expirable = openTask("t-batch-expirable");
  expirable.setSlaDeadline(PAST);
  const second = openTask("t-batch-second");
  second.setSlaDeadline(PAST);
  const notOverdue = openTask("t-batch-not-overdue");
  notOverdue.setSlaDeadline(FUTURE);
  const noDeadline = openTask("t-batch-no-deadline");
  const terminal = abandonedTask("t-batch-terminal");
  terminal.setSlaDeadline(PAST, "ABANDONED"); // past deadline, but terminal

  const a = collect(expirable);
  const b = collect(second);
  const c = collect(notOverdue);
  const d = collect(noDeadline);
  const e = collect(terminal);

  const results = expireOverdueTasks(
    [expirable, second, notOverdue, noDeadline, terminal],
    NOW,
  );

  // Only the two overdue non-terminal tasks are attempted.
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.expired));
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0][0], "EXPIRE");
  assert.equal(a.calls[0][2], "EXPIRED");
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0][0], "EXPIRE");
  assert.equal(b.calls[0][2], "EXPIRED");
  // Untouched tasks produce no result entry and no notification.
  assert.equal(c.calls.length, 0);
  assert.equal(d.calls.length, 0);
  assert.equal(e.calls.length, 0);
  assert.equal(notOverdue.state, "OPEN");
  assert.equal(noDeadline.state, "OPEN");
  assert.equal(terminal.state, "ABANDONED");
});

test("expireOverdueSubscribe: failure-isolated task notifies nobody and the batch continues", () => {
  const stuck = inReviewTask("t-stuck");
  stuck.setSlaDeadline(PAST);
  const expirable = openTask("t-after-stuck");
  expirable.setSlaDeadline(PAST);
  const s = collect(stuck);
  const a = collect(expirable);
  const before = JSON.stringify(stuck.history);

  // Unexpirable task deliberately listed FIRST.
  const results = expireOverdueTasks([stuck, expirable], NOW);
  assert.equal(results.length, 2);

  const blocked = byId(results, "t-stuck");
  assert.equal(blocked.expired, false);
  assert.match(blocked.error ?? "", /invalid transition: EXPIRE from IN_REVIEW/);
  assert.equal(blocked.entry, undefined);
  assert.equal(s.calls.length, 0);
  assert.equal(stuck.state, "IN_REVIEW");
  assert.equal(JSON.stringify(stuck.history), before);

  assert.equal(byId(results, "t-after-stuck").expired, true);
  assert.equal(expirable.state, "EXPIRED");
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0][0], "EXPIRE");
  assert.equal(a.calls[0][3].actor, "system");
});

test("expireOverdueSubscribe: unsubscribed listener stays silent while the executor still expires", () => {
  const t = openTask("t-unsub");
  t.setSlaDeadline(PAST);
  const { calls, unsub } = collect(t);
  assert.equal(t.listenerCount, 1);

  unsub();
  assert.equal(t.listenerCount, 0);

  const [result] = expireOverdueTasks([t], NOW);

  assert.equal(result.expired, true);
  assert.equal(t.state, "EXPIRED");
  assert.equal(t.history.length, 2);
  assert.equal(calls.length, 0);
});

test("expireOverdueSubscribe: a throwing listener does not break the executor action or its peer", () => {
  const t = openTask("t-throwing");
  t.setSlaDeadline(PAST);
  t.subscribe(() => {
    throw new Error("boom: bad fan-out consumer");
  });
  const peer = collect(t);

  const [result] = expireOverdueTasks([t], NOW);

  assert.equal(result.expired, true);
  assert.equal(t.state, "EXPIRED");
  assert.equal(t.history.length, 2);
  assert.equal(peer.calls.length, 1);
  assert.equal(peer.calls[0][0], "EXPIRE");
  assert.equal(peer.calls[0][2], "EXPIRED");
});
