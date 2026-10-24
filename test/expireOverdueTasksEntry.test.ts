/**
 * ExpireOverdueResult.entry — the auditable watchdog report (backlog #544).
 *
 * expireOverdueTasks() attaches the EXPIRE audit entry to successful
 * outcomes: a frozen, detached copy of the task's last history entry, so
 * an SLA operations report can cite it (which task, from which state,
 * when) without re-reading task.history. Failed dispatches omit the
 * field entirely, keeping the failure shape backward compatible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, expireOverdueTasks } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");

function openTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster" });
  t.setSlaDeadline(PAST);
  return t; // OPEN, overdue — has an EXPIRE edge
}

function stuckTask(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.setSlaDeadline(PAST);
  return t; // IN_REVIEW, overdue — no EXPIRE edge
}

function lastEntry(task: TaskLifecycle) {
  const history = task.history;
  return history[history.length - 1];
}

describe("expireOverdueTasks entry (auditable watchdog report)", () => {
  it("attaches a frozen copy of the EXPIRE audit entry on success", () => {
    const t = openTask("ok");
    const results = expireOverdueTasks([t], NOW);

    assert.equal(results.length, 1);
    const result = results[0];
    assert.equal(result.expired, true);
    assert.ok(result.entry, "expected entry on success");

    const live = lastEntry(t);
    assert.equal(result.entry.seq, live.seq);
    assert.equal(result.entry.from, live.from);
    assert.equal(result.entry.to, live.to);
    assert.equal(result.entry.at, live.at);
    assert.deepEqual(result.entry, live);
    assert.ok(Object.isFrozen(result.entry), "entry must be frozen");
  });

  it("the attached entry describes the EXPIRE transition itself", () => {
    const t = openTask("audit");
    const [result] = expireOverdueTasks([t], NOW);

    assert.equal(result.entry?.event, "EXPIRE");
    assert.equal(result.entry?.from, "OPEN");
    assert.equal(result.entry?.to, "EXPIRED");
    assert.equal(result.entry?.actor, "system");
  });

  it("omits the entry field entirely on a failed dispatch", () => {
    const t = stuckTask("stuck");
    const [result] = expireOverdueTasks([t], NOW);

    assert.equal(result.expired, false);
    assert.ok(result.error, "expected an error message");
    assert.ok(
      !("entry" in result),
      "failed outcome must not carry an entry field",
    );
  });

  it("the entry is detached: a fresh read is deep-equal but reference-independent, and writes throw", () => {
    const t = openTask("detached");
    const [result] = expireOverdueTasks([t], NOW);
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
    assert.equal(t.state, "EXPIRED");
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(expireOverdueTasks([], NOW), []);
  });

  it("mixed batch: successes carry entries, failures carry none", () => {
    const ok = openTask("ok");
    const stuck = stuckTask("stuck");
    const results = expireOverdueTasks([ok, stuck], NOW);

    assert.equal(results.length, 2);
    assert.equal(results[0].expired, true);
    assert.ok(results[0].entry, "success must carry entry");
    assert.equal(results[0].entry?.to, "EXPIRED");
    assert.equal(results[1].expired, false);
    assert.ok(!("entry" in results[1]), "failure must omit entry");
  });

  it("a not-overdue task is never attempted and produces no entry", () => {
    const t = new TaskLifecycle("future");
    t.dispatch("PUBLISH", { actor: "poster" });
    t.setSlaDeadline(FUTURE);

    const results = expireOverdueTasks([t], NOW);
    assert.deepEqual(results, []);
    assert.equal(t.state, "OPEN");
  });
});
