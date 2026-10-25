/**
 * StaleActionResult.entry — the auditable stale-patrol report (backlog #571).
 *
 * actOnStaleTasks() attaches the audit entry its action appended to
 * successful outcomes, mirroring what expireOverdueTasks() already does
 * for ExpireOverdueResult (#544): a frozen, detached copy of the task's
 * last history entry, so a stale-patrol report can cite it (which task,
 * from which state, when) without re-reading task.history. A
 * notify-only action appends nothing, so its successful outcomes omit
 * the field; failed actions omit it as well, keeping the failure shape
 * backward compatible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, actOnStaleTasks } from "../src/index.js";
import type { TaskEvent, TaskHistoryEntry, TaskState } from "../src/index.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 24 * 3600_000;
const iso = (d: Date): string => d.toISOString();
const daysAgo = (n: number): string => iso(new Date(NOW.getTime() - n * DAY));

type Step = [TaskEvent, TaskState, TaskState, string];

/** Deterministic task builder, same pattern as actOnStaleTasks.test.ts. */
function taskAt(id: string, steps: Step[]): TaskLifecycle {
  const history: TaskHistoryEntry[] = steps.map(([event, from, to, at], i) => ({
    seq: i + 1,
    event,
    from,
    to,
    at,
    actor: "system",
  }));
  return TaskLifecycle.fromHistory(id, history);
}

function acceptedStale(id: string): TaskLifecycle {
  return taskAt(id, [
    ["PUBLISH", "DRAFT", "OPEN", daysAgo(30)],
    ["ACCEPT", "OPEN", "ACCEPTED", daysAgo(20)], // 20d in ACCEPTED > 7d
  ]);
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

function lastEntry(task: TaskLifecycle) {
  const history = task.history;
  return history[history.length - 1];
}

describe("actOnStaleTasks entry (auditable stale-patrol report)", () => {
  it("attaches a frozen copy of the ABANDON audit entry on default-action success", () => {
    const t = acceptedStale("ok");
    const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

    assert.equal(result.acted, true);
    assert.ok(result.entry, "expected entry on success");

    const live = lastEntry(t);
    assert.deepEqual(result.entry, live);
    assert.equal(result.entry.seq, live.seq);
    assert.equal(result.entry.from, live.from);
    assert.equal(result.entry.to, live.to);
    assert.equal(result.entry.at, live.at);
    assert.ok(Object.isFrozen(result.entry), "entry must be frozen");
  });

  it("the attached entry describes the ABANDON transition itself", () => {
    const t = acceptedStale("audit");
    const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

    assert.equal(result.entry?.event, "ABANDON");
    assert.equal(result.entry?.from, "ACCEPTED");
    assert.equal(result.entry?.to, "ABANDONED");
    assert.equal(result.entry?.actor, "system");
  });

  it("a custom dispatching action also carries the entry it appended", () => {
    const t = acceptedStale("custom");
    const [result] = actOnStaleTasks(
      [t],
      (task) => task.dispatch("ABANDON", { actor: "moderator" }),
      BUDGET,
      NOW,
    );

    assert.equal(result.acted, true);
    assert.equal(result.entry?.event, "ABANDON");
    assert.equal(result.entry?.actor, "moderator");
    assert.deepEqual(result.entry, lastEntry(t));
  });

  it("omits the entry field entirely for a notify-only action that appends nothing", () => {
    const t = acceptedStale("notify");
    const before = JSON.stringify(t.history);
    const [result] = actOnStaleTasks(
      [t],
      () => {
        /* page on-call, no dispatch */
      },
      BUDGET,
      NOW,
    );

    assert.equal(result.acted, true);
    assert.ok(
      !("entry" in result),
      "notify-only success must not carry an entry field",
    );
    assert.equal(JSON.stringify(t.history), before);
  });

  it("omits the entry field entirely on a failed default action, history unchanged", () => {
    const t = submittedStale("stuck");
    const before = JSON.stringify(t.history);
    const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);

    assert.equal(result.acted, false);
    assert.ok(result.error, "expected an error message");
    assert.ok(
      !("entry" in result),
      "failed outcome must not carry an entry field",
    );
    assert.equal(JSON.stringify(t.history), before);
  });

  it("omits the entry on a throwing custom action even if it dispatched first", () => {
    const t = acceptedStale("throw-after-dispatch");
    const [result] = actOnStaleTasks(
      [t],
      (task) => {
        task.dispatch("ABANDON", { actor: "system" });
        throw new Error("page failed after abandon");
      },
      BUDGET,
      NOW,
    );

    // Failure shape is unchanged: no entry, even though the history grew.
    assert.equal(result.acted, false);
    assert.equal(result.error, "page failed after abandon");
    assert.ok(!("entry" in result));
    assert.equal(t.state, "ABANDONED");
  });

  it("the entry is detached: a fresh read is deep-equal but reference-independent, and writes throw", () => {
    const t = acceptedStale("detached");
    const [result] = actOnStaleTasks([t], undefined, BUDGET, NOW);
    const entry = result.entry!;
    const fresh = lastEntry(t);

    assert.deepEqual(entry, fresh);
    assert.notEqual(entry, fresh, "must not share the reference");
    assert.throws(
      () => {
        (entry as { note?: string }).note = "forged";
      },
      TypeError,
      "writing a frozen entry must throw",
    );
    // the task's own audit trail is untouched by the probe
    assert.equal(lastEntry(t).note, undefined);
    assert.equal(t.state, "ABANDONED");
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(actOnStaleTasks([], undefined, BUDGET, NOW), []);
  });

  it("mixed batch: successes carry entries, failures carry none, order preserved", () => {
    const ok = acceptedStale("ok");
    const stuck = submittedStale("stuck");
    const results = actOnStaleTasks([ok, stuck], undefined, BUDGET, NOW);

    assert.equal(results.length, 2);
    assert.equal(results[0].acted, true);
    assert.ok(results[0].entry, "success must carry entry");
    assert.equal(results[0].entry?.to, "ABANDONED");
    assert.equal(results[1].acted, false);
    assert.ok(!("entry" in results[1]), "failure must omit entry");
    assert.deepEqual(
      results.map((r) => r.task.id),
      ["ok", "stuck"],
    );
  });
});
