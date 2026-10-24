/**
 * `expireOverdueTasks` signs its EXPIRE dispatches as `system` (backlog #550).
 *
 * The watchdog used to dispatch EXPIRE anonymously, so a later reader
 * could not tell a watchdog-driven expiry apart from a human-driven one.
 * The executor now attributes every successful EXPIRE dispatch to the
 * `system` actor — the same attribution `actOnStaleTasks` uses for its
 * default ABANDON action — keeping the two watchdog executors in one
 * audit-attribution family.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
  expireOverdueTasks,
  verifyHistoryChain,
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

function lastEntry(task: TaskLifecycle) {
  const history = task.history;
  return history[history.length - 1];
}

describe("expireOverdueTasks system-actor attribution (#550)", () => {
  it("signs a successful EXPIRE dispatch with actor \"system\" and keeps the hash chain intact", () => {
    const t = openTask("signed");
    t.setSlaDeadline(PAST);

    const [result] = expireOverdueTasks([t], NOW);
    assert.equal(result.expired, true);
    assert.ok(result.entry, "expected entry on success");

    // attribution is on both the live history entry and the report copy
    assert.equal(lastEntry(t).actor, "system");
    assert.equal(result.entry.actor, "system");

    // the attributed entry is covered by the tamper-evident chain
    assert.equal(verifyHistoryChain(t.history), true);
  });

  it("a failed dispatch leaves the task untouched: no system signature anywhere", () => {
    const stuck = inReviewTask("stuck");
    stuck.setSlaDeadline(PAST);
    const before = JSON.stringify(stuck.history);

    const [result] = expireOverdueTasks([stuck], NOW);
    assert.equal(result.expired, false);
    assert.ok(result.error, "expected an error message");

    // failed tasks are untouched: no new entry, no residue
    assert.equal(stuck.state, "IN_REVIEW");
    assert.equal(JSON.stringify(stuck.history), before);
    assert.ok(!("entry" in result), "failure must not carry an entry field");
    assert.ok(
      !stuck.history.some((entry) => entry.actor === "system"),
      "no system-attributed entry may leak into a failed task",
    );
  });

  it("a not-overdue task is never attempted and carries no system attribution", () => {
    const t = openTask("future");
    t.setSlaDeadline(FUTURE);

    const results = expireOverdueTasks([t], NOW);
    assert.deepEqual(results, []);
    assert.equal(t.history.length, 1); // only the PUBLISH entry
    assert.equal(t.state, "OPEN");
  });

  it("matches actOnStaleTasks' default action: both watchdog executors attribute to \"system\"", () => {
    // ACCEPTED + budget 0: stale the instant it entered ACCEPTED (same
    // pattern as actOnStaleTasks.test.ts), and also overdue for EXPIRE
    const t = openTask("cross-check");
    t.dispatch("ACCEPT", { actor: "contributor" });
    t.setSlaDeadline(PAST);

    const now = new Date(Date.now() + 1000);
    const [abandoned] = actOnStaleTasks([t], undefined, { ACCEPTED: 0 }, now);
    assert.equal(abandoned.acted, true);
    assert.equal(lastEntry(t).event, "ABANDON");
    assert.equal(lastEntry(t).actor, "system");

    // a fresh twin shows the expiry side of the same attribution family
    const twin = openTask("cross-check-expiry");
    twin.dispatch("ACCEPT", { actor: "contributor" });
    twin.setSlaDeadline(PAST);
    const [expired] = expireOverdueTasks([twin], now);
    assert.equal(expired.expired, true);
    assert.equal(lastEntry(twin).event, "EXPIRE");
    assert.equal(lastEntry(twin).actor, "system");
  });
});
