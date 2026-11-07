/**
 * watchdog executors x `requireActor` (backlog #957).
 *
 * `expireOverdueTasks` and `actOnStaleTasks` dispatch with the fixed
 * `system` actor (`src/taskLifecycle.ts`), so they should sail through a
 * task that has `requireActor: true` — but no test ever combined the two:
 * `grep -rln requireActor test/expireOverdueTasks*.test.ts
 * test/actOnStaleTasks*.test.ts` was empty, and `test/requireActor.test.ts`
 * only covers bare dispatch and `fromHistory` re-attachment. The watchdogs
 * are the only callers that dispatch on a task's behalf with a fixed actor,
 * so they are the most likely place for the attribution gate to quietly
 * change behaviour.
 *
 * Rules under test:
 *  - a `requireActor: true` overdue task is EXPIREd by
 *    `expireOverdueTasks`, the entry carrying actor `system`
 *  - a `requireActor: true` stale task is ABANDONed by `actOnStaleTasks`,
 *    the entry carrying actor `system`
 *  - the control group: a bare dispatch without an actor on the same task
 *    still throws `actor required` and leaves no residue, and the watchdog
 *    still succeeds on that same instance afterwards
 *  - `fromHistory` re-attaching `requireActor` keeps both watchdogs working
 *  - per-task isolation holds in a mixed batch: an unexpirable task reports
 *    its transition error while the `requireActor` sibling still expires
 *  - a pinned `at` still stamps the watchdog entry with actor `system`
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
  expireOverdueTasks,
  verifyHistoryChain,
} from "../src/index.js";
import type { TaskHistoryEntry } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

function lastEntry(task: TaskLifecycle): TaskHistoryEntry {
  const history = task.history;
  return history[history.length - 1];
}

/** Deterministic history builder, same pattern as actOnStaleTasks.test.ts. */
function taskFromSteps(
  id: string,
  steps: [string, string, string, string][],
  opts?: { requireActor?: boolean },
): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event: event as TaskHistoryEntry["event"],
    from: from as TaskHistoryEntry["from"],
    to: to as TaskHistoryEntry["to"],
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history, opts);
}

/** OPEN for 30 days, with an SLA deadline long past. */
function overdueOpenTask(
  id: string,
  opts?: { requireActor?: boolean },
): TaskLifecycle {
  const t = taskFromSteps(
    id,
    [["PUBLISH", "DRAFT", "OPEN", daysAgo(30)]],
    opts,
  );
  t.setSlaDeadline(PAST);
  return t;
}

/** ACCEPTED for 20 days, past the 7-day stale budget. */
function staleAcceptedTask(
  id: string,
  opts?: { requireActor?: boolean },
): TaskLifecycle {
  return taskFromSteps(
    id,
    [
      ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
      ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)],
    ],
    opts,
  );
}

/** IN_REVIEW for 12 days: overdue by SLA but with no EXPIRE edge. */
function unexpirableTask(id: string): TaskLifecycle {
  const t = taskFromSteps(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(25)],
    ["START_CAPTURE", "ACCEPTED", "CAPTURING", daysAgo(20)],
    ["SUBMIT", "CAPTURING", "SUBMITTED", daysAgo(15)],
    ["BEGIN_REVIEW", "SUBMITTED", "IN_REVIEW", daysAgo(12)],
  ]);
  t.setSlaDeadline(PAST);
  return t;
}

const STALE_BUDGET = {
  ACCEPTED: 7 * DAY,
  CAPTURING: 7 * DAY,
  SUBMITTED: 7 * DAY,
  OPEN: 30 * DAY,
  IN_REVIEW: 7 * DAY,
};

test("expireOverdueTasks EXPIREs a requireActor task, signed as system", () => {
  const t = overdueOpenTask("watchdog-ra-expire", { requireActor: true });

  const [result] = expireOverdueTasks([t], NOW);
  assert.equal(result.expired, true);
  assert.equal(t.state, "EXPIRED");
  assert.ok(result.entry, "expected entry on success");

  // attribution is on both the live history entry and the report copy
  assert.equal(lastEntry(t).actor, "system");
  assert.equal(lastEntry(t).event, "EXPIRE");
  assert.equal(result.entry.actor, "system");

  // the attributed entry is covered by the tamper-evident chain
  assert.equal(verifyHistoryChain(t.history), true);
});

test("actOnStaleTasks ABANDONs a requireActor task, signed as system", () => {
  const t = staleAcceptedTask("watchdog-ra-stale", { requireActor: true });

  const [result] = actOnStaleTasks([t], undefined, STALE_BUDGET, NOW);
  assert.equal(result.acted, true);
  assert.equal(t.state, "ABANDONED");
  assert.ok(result.entry, "expected entry on success");

  assert.equal(lastEntry(t).actor, "system");
  assert.equal(lastEntry(t).event, "ABANDON");
  assert.equal(result.entry.actor, "system");

  assert.equal(verifyHistoryChain(t.history), true);
});

test("control: bare dispatch without an actor still throws, watchdog still works on the same task", () => {
  const t = overdueOpenTask("watchdog-ra-control", { requireActor: true });
  const before = t.history.length;

  // the gate still bites a human-style dispatch with no actor
  assert.throws(
    () => t.dispatch("ACCEPT"),
    /actor required: dispatch must carry a non-empty actor when requireActor is enabled/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "OPEN");

  // ...and the watchdog, which always carries `system`, is unaffected
  const [result] = expireOverdueTasks([t], NOW);
  assert.equal(result.expired, true);
  assert.equal(t.state, "EXPIRED");
  assert.equal(lastEntry(t).actor, "system");
});

test("fromHistory re-attaching requireActor keeps expireOverdueTasks working", () => {
  // restore the same log twice: once advisory, once with the gate on
  const history = overdueOpenTask("watchdog-ra-reattach").history;
  const plain = TaskLifecycle.fromHistory("watchdog-ra-reattach", history);
  const gated = TaskLifecycle.fromHistory("watchdog-ra-reattach", history, {
    requireActor: true,
  });

  // the gate really is on for the re-attached task
  assert.throws(() => gated.dispatch("ACCEPT"), /actor required/);

  // and the watchdog still expires it (deadline re-attached, as SLA
  // deadlines are config, not audit data)
  gated.setSlaDeadline(PAST);
  const [result] = expireOverdueTasks([gated], NOW);
  assert.equal(result.expired, true);
  assert.equal(gated.state, "EXPIRED");
  assert.equal(lastEntry(gated).actor, "system");

  // the advisory twin is untouched by construction
  assert.equal(plain.state, "OPEN");
});

test("fromHistory re-attaching requireActor keeps actOnStaleTasks working", () => {
  const history = staleAcceptedTask("watchdog-ra-reattach-stale").history;
  const gated = TaskLifecycle.fromHistory(
    "watchdog-ra-reattach-stale",
    history,
    { requireActor: true },
  );

  assert.throws(() => gated.dispatch("START_CAPTURE"), /actor required/);

  const [result] = actOnStaleTasks([gated], undefined, STALE_BUDGET, NOW);
  assert.equal(result.acted, true);
  assert.equal(gated.state, "ABANDONED");
  assert.equal(lastEntry(gated).actor, "system");
  assert.equal(verifyHistoryChain(gated.history), true);
});

test("mixed batch: an unexpirable task does not block a requireActor sibling", () => {
  const gated = overdueOpenTask("watchdog-ra-batch-ok", {
    requireActor: true,
  });
  const stuck = unexpirableTask("watchdog-ra-batch-stuck");

  const results = expireOverdueTasks([stuck, gated], NOW);
  assert.equal(results.length, 2);

  // the stuck task fails on the missing EXPIRE edge, not on the actor gate
  assert.equal(results[0].expired, false);
  assert.match(results[0].error ?? "", /invalid transition: EXPIRE from IN_REVIEW/);
  assert.equal(stuck.state, "IN_REVIEW");

  // the requireActor sibling still expires in the same batch
  assert.equal(results[1].expired, true);
  assert.equal(gated.state, "EXPIRED");
  assert.equal(lastEntry(gated).actor, "system");
});

test("pinned at still stamps the watchdog entry with actor system on a requireActor task", () => {
  const t = overdueOpenTask("watchdog-ra-pinned-at", { requireActor: true });

  const [result] = expireOverdueTasks([t], NOW, NOW);
  assert.equal(result.expired, true);
  assert.equal(lastEntry(t).at, iso(NOW));
  assert.equal(lastEntry(t).actor, "system");
  assert.equal(result.entry?.at, iso(NOW));
  assert.equal(verifyHistoryChain(t.history), true);
});
