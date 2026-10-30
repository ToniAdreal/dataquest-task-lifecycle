/**
 * actOnStaleTasks x subscribe combination (backlog #732).
 *
 * `actOnStaleTasks()`'s default action is a `dispatch("ABANDON",
 * { actor: "system" })`, and `subscribe()` promises a notification
 * after every successful dispatch. Each half has its own tests
 * (`actOnStaleTasks.test.ts` pins the per-task executor,
 * `subscribe.test.ts` pins the notification contract), but the
 * combination was untested: a watchdog-driven batch abandon must
 * notify the abandoned task's listeners exactly once with the
 * ABANDON audit entry, a refused or failed action must notify
 * nobody, a notify-only custom action must notify nobody, and an
 * unsubscribed listener must stay silent while the executor still
 * abandons the task. This is the stale-action counterpart of the
 * RBAC combination (#707), with a different second half — its
 * conclusions are pinned here, not borrowed from #707.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
} from "../src/index.js";
import type {
  StaleActionResult,
  TaskEvent,
  TaskHistoryEntry,
  TaskLifecycleOptions,
  TaskState,
} from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];
type Call = [TaskEvent, TaskState, TaskState, TaskHistoryEntry];

/** Deterministic task builder, same pattern as actOnStaleTasks.test.ts. */
function taskAt(
  id: string,
  steps: Step[],
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event,
    from,
    to,
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history, opts);
}

function acceptedStale(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  return taskAt(
    id,
    [
      ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
      ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)], // 20d in ACCEPTED > 7d
    ],
    opts,
  );
}

function capturingStale(
  id: string,
  opts?: TaskLifecycleOptions,
): TaskLifecycle {
  return taskAt(
    id,
    [
      ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
      ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
      ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(15)], // 15d > 7d
    ],
    opts,
  );
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

function collect(task: TaskLifecycle): { calls: Call[]; unsub: () => void } {
  const calls: Call[] = [];
  const unsub = task.subscribe((event, from, to, entry) => {
    calls.push([event, from, to, entry]);
  });
  return { calls, unsub };
}

test("staleActionSubscribe: default ABANDON notifies exactly once with the audit entry", () => {
  const t = acceptedStale("t-notified");
  const { calls } = collect(t);

  const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

  assert.equal(result.acted, true);
  assert.equal(t.state, "ABANDONED");
  assert.equal(t.history.length, 3);
  assert.equal(calls.length, 1);
  const [event, from, to, entry] = calls[0];
  assert.equal(event, "ABANDON");
  assert.equal(from, "ACCEPTED");
  assert.equal(to, "ABANDONED");
  assert.equal(entry.event, "ABANDON");
  assert.equal(entry.from, "ACCEPTED");
  assert.equal(entry.to, "ABANDONED");
  assert.equal(entry.actor, "system");
  assert.equal(entry.seq, 3);
  // Delivered entry is the appended audit entry, frozen like the
  // history copy, and matches the executor's reported entry.
  assert.ok(Object.isFrozen(entry));
  assert.deepEqual({ ...entry }, { ...t.history[t.history.length - 1] });
  assert.deepEqual({ ...entry }, { ...(result.entry as TaskHistoryEntry) });
});

test("staleActionSubscribe: batch notifies only the acted tasks, each once", () => {
  const accepted = acceptedStale("t-batch-accepted");
  const capturing = capturingStale("t-batch-capturing");
  const fresh = taskAt("t-batch-fresh", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(1)], // 1d < 7d: not stale
  ]);
  const terminal = taskAt("t-batch-terminal", [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(40)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(35)],
    ["ABANDON", "ACCEPTED", "ABANDONED", daysAgo(34)], // terminal: never stale
  ]);
  const a = collect(accepted);
  const b = collect(capturing);
  const c = collect(fresh);
  const d = collect(terminal);

  const results = actOnStaleTasks(
    [accepted, capturing, fresh, terminal],
    undefined,
    BUDGET,
    NOW,
  );

  // Only the two stale non-terminal tasks are attempted.
  assert.equal(results.length, 2);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0][0], "ABANDON");
  assert.equal(a.calls[0][2], "ABANDONED");
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0][0], "ABANDON");
  assert.equal(b.calls[0][2], "ABANDONED");
  // Untouched tasks produce no result entry and no notification.
  assert.equal(c.calls.length, 0);
  assert.equal(d.calls.length, 0);
  assert.equal(fresh.state, "ACCEPTED");
  assert.equal(fresh.history.length, 2);
  assert.equal(terminal.state, "ABANDONED");
  assert.equal(terminal.history.length, 3);
});

test("staleActionSubscribe: policy-refused task notifies nobody and the batch continues", () => {
  const refused = acceptedStale("t-refused", {
    rolePolicy: { ABANDON: ["ops-lead"] },
  });
  const allowed = acceptedStale("t-allowed", {
    rolePolicy: { ABANDON: ["system"] },
  });
  const free = capturingStale("t-free");
  const r = collect(refused);
  const a = collect(allowed);
  const f = collect(free);

  const results = actOnStaleTasks([refused, allowed, free], undefined, BUDGET, NOW);
  assert.equal(results.length, 3);

  const blocked = byId(results, "t-refused");
  assert.equal(blocked.acted, false);
  assert.equal(
    blocked.error,
    'actor not authorized for ABANDON: "system" is not in [ops-lead]',
  );
  assert.equal(blocked.entry, undefined);
  assert.equal(r.calls.length, 0);
  assert.equal(refused.state, "ACCEPTED");
  assert.equal(refused.history.length, 2);
  assert.deepEqual(
    refused.history.map((e) => e.seq),
    [1, 2],
  );

  // The refusal consumes nothing: the allowlisted actor can still
  // abandon it afterwards, and that manual dispatch does notify.
  refused.dispatch("ABANDON", { actor: "ops-lead" });
  assert.equal(refused.state, "ABANDONED");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0][0], "ABANDON");
  assert.equal(r.calls[0][3].actor, "ops-lead");

  assert.equal(byId(results, "t-allowed").acted, true);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0][3].actor, "system");
  assert.equal(byId(results, "t-free").acted, true);
  assert.equal(f.calls.length, 1);
});

test("staleActionSubscribe: failed transition notifies nobody and leaves no trace", () => {
  const stuck = submittedStale("t-stuck");
  const { calls } = collect(stuck);
  const before = JSON.stringify(stuck.history);

  const [result] = actOnStaleTasks([stuck], undefined, BUDGET, NOW);

  assert.equal(result.acted, false);
  assert.match(result.error ?? "", /invalid transition: ABANDON from SUBMITTED/);
  assert.equal(result.entry, undefined);
  assert.equal(calls.length, 0);
  assert.equal(stuck.state, "SUBMITTED");
  assert.equal(JSON.stringify(stuck.history), before);
});

test("staleActionSubscribe: notify-only custom action notifies nobody", () => {
  const accepted = acceptedStale("t-notify-a");
  const submitted = submittedStale("t-notify-b");
  const a = collect(accepted);
  const b = collect(submitted);
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
  assert.ok(results.every((r) => r.entry === undefined));
  assert.equal(a.calls.length, 0);
  assert.equal(b.calls.length, 0);
  assert.equal(accepted.state, "ACCEPTED");
  assert.equal(submitted.state, "SUBMITTED");
  assert.equal(accepted.history.length, 2);
  assert.equal(submitted.history.length, 4);
});

test("staleActionSubscribe: unsubscribed listener stays silent while the executor still abandons", () => {
  const t = acceptedStale("t-unsub");
  const { calls, unsub } = collect(t);
  assert.equal(t.listenerCount, 1);

  unsub();
  assert.equal(t.listenerCount, 0);

  const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

  assert.equal(result.acted, true);
  assert.equal(t.state, "ABANDONED");
  assert.equal(t.history.length, 3);
  assert.equal(calls.length, 0);
});

test("staleActionSubscribe: a throwing listener does not break the executor action or its peer", () => {
  const t = acceptedStale("t-throwing");
  t.subscribe(() => {
    throw new Error("boom: bad fan-out consumer");
  });
  const peer = collect(t);

  const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

  assert.equal(result.acted, true);
  assert.equal(t.state, "ABANDONED");
  assert.equal(t.history.length, 3);
  assert.equal(peer.calls.length, 1);
  assert.equal(peer.calls[0][0], "ABANDON");
  assert.equal(peer.calls[0][2], "ABANDONED");
});
