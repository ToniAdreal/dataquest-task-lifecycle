/**
 * stuckTasks watchdog selector (backlog #1440, mirrors escrow #1434).
 *
 * `expiredTasks()` flags every overdue task, but a `DRAFT`, `REJECTED`
 * or `DISPUTED` task has no `EXPIRE` edge — a draft must be published
 * or reworked, a rejected task goes back through dispute or
 * resubmission, and arbitration must not be walked out of
 * unilaterally — so no executor can ever expire it. Before this item,
 * the watchdog re-reported the same transition error for those tasks
 * every round, and the operator had no way to tell "already expired"
 * from "overdue but unexpirable". `stuckTasks()` lists exactly the
 * unexpirable subset, so `stuckTasks` + expirable-overdue partitions
 * `expiredTasks` with no overlap and no gap, and
 * `expireOverdueTasks` classifies those tasks as
 * `{ expired: false, unexpirable: true }` instead of failing them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expiredTasks,
  expireOverdueTasks,
  stuckTasks,
} from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Fixture audit timestamps: pinned strictly before NOW, because
// expireOverdueTasks pins the screening `now` as each EXPIRE entry's
// `at`, and dispatch rejects a backward-moving audit clock.
const PUBLISH_AT = "2026-01-01T00:00:00.000Z";
const ACCEPT_AT = "2026-02-01T00:00:00.000Z";
const CAPTURE_AT = "2026-02-15T00:00:00.000Z";
const SUBMIT_AT = "2026-03-01T00:00:00.000Z";
const REVIEW_AT = "2026-03-15T00:00:00.000Z";
const DISPUTE_AT = "2026-04-01T00:00:00.000Z";

function draftWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.setSlaDeadline(deadline);
  return task;
}

// Chain builders: no deadline — the deadline is always set for the
// task's FINAL state, because setSlaDeadline stores per state and
// isOverdue reads the deadline of the current state only.
function toOpen(task: TaskLifecycle): TaskLifecycle {
  task.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  return task;
}

function toInReview(task: TaskLifecycle): TaskLifecycle {
  toOpen(task);
  task.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
  task.dispatch("START_CAPTURE", { actor: "contributor", at: CAPTURE_AT });
  task.dispatch("SUBMIT", { actor: "contributor", at: SUBMIT_AT });
  task.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: REVIEW_AT });
  return task;
}

function toRejected(task: TaskLifecycle): TaskLifecycle {
  toInReview(task);
  task.dispatch("REJECT", { actor: "reviewer", at: REVIEW_AT });
  return task;
}

function toDisputed(task: TaskLifecycle): TaskLifecycle {
  toRejected(task);
  task.dispatch("DISPUTE", { actor: "poster", at: DISPUTE_AT });
  return task;
}

function toAbandoned(task: TaskLifecycle): TaskLifecycle {
  toOpen(task);
  task.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
  task.dispatch("ABANDON", { actor: "contributor", at: DISPUTE_AT });
  return task;
}

function openWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = toOpen(new TaskLifecycle(id));
  task.setSlaDeadline(deadline);
  return task;
}

function inReviewWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = toInReview(new TaskLifecycle(id));
  task.setSlaDeadline(deadline);
  return task;
}

function rejectedWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = toRejected(new TaskLifecycle(id));
  task.setSlaDeadline(deadline);
  return task;
}

function disputedWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = toDisputed(new TaskLifecycle(id));
  task.setSlaDeadline(deadline);
  return task;
}

function abandonedWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const task = toAbandoned(new TaskLifecycle(id));
  task.setSlaDeadline(deadline);
  return task;
}

function ids(tasks: TaskLifecycle[]): string[] {
  return tasks.map((t) => t.id);
}

describe("stuckTasks", () => {
  it("an overdue DRAFT task is stuck", () => {
    const draft = draftWithDeadline("draft", PAST);
    assert.deepEqual(ids(stuckTasks([draft], NOW)), ["draft"]);
  });

  it("an overdue REJECTED task is stuck", () => {
    const rejected = rejectedWithDeadline("rejected", PAST);
    assert.deepEqual(ids(stuckTasks([rejected], NOW)), ["rejected"]);
  });

  it("an overdue DISPUTED task is stuck", () => {
    const disputed = disputedWithDeadline("disputed", PAST);
    assert.deepEqual(ids(stuckTasks([disputed], NOW)), ["disputed"]);
  });

  it("overdue tasks with an EXPIRE edge are not stuck: OPEN, IN_REVIEW", () => {
    const batch = [
      openWithDeadline("open", PAST),
      inReviewWithDeadline("in-review", PAST),
    ];
    assert.deepEqual(stuckTasks(batch, NOW), []);
    // ...but they are all overdue, so the expired selection does list them.
    assert.deepEqual(ids(expiredTasks(batch, NOW)), ["open", "in-review"]);
  });

  it("a not-yet-overdue REJECTED task is not stuck", () => {
    const rejected = rejectedWithDeadline("not-yet", FUTURE);
    assert.deepEqual(stuckTasks([rejected], NOW), []);
  });

  it("a terminal task is never stuck, even with a past deadline", () => {
    const abandoned = abandonedWithDeadline("abandoned", PAST);
    assert.equal(abandoned.state, "ABANDONED");
    assert.deepEqual(stuckTasks([abandoned], NOW), []);
    assert.deepEqual(expiredTasks([abandoned], NOW), []);
  });

  it("a deadline-less DISPUTED task is not stuck", () => {
    const disputed = new TaskLifecycle("no-deadline");
    disputed.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
    disputed.dispatch("ACCEPT", { actor: "contributor", at: ACCEPT_AT });
    disputed.dispatch("START_CAPTURE", { actor: "contributor", at: CAPTURE_AT });
    disputed.dispatch("SUBMIT", { actor: "contributor", at: SUBMIT_AT });
    disputed.dispatch("BEGIN_REVIEW", { actor: "reviewer", at: REVIEW_AT });
    disputed.dispatch("REJECT", { actor: "reviewer", at: REVIEW_AT });
    disputed.dispatch("DISPUTE", { actor: "poster", at: DISPUTE_AT });
    assert.deepEqual(stuckTasks([disputed], NOW), []);
  });

  it("returns the same instances in input order and changes nothing", () => {
    const first = rejectedWithDeadline("first", PAST);
    const middle = openWithDeadline("middle", PAST);
    const last = disputedWithDeadline("last", PAST);
    const before = [first, middle, last].map((t) => ({
      state: t.state,
      history: t.history,
    }));

    const stuck = stuckTasks([first, middle, last], NOW);

    assert.equal(stuck.length, 2);
    assert.equal(stuck[0], first);
    assert.equal(stuck[1], last);
    assert.deepEqual(
      [first, middle, last].map((t) => ({ state: t.state, history: t.history })),
      before,
    );
  });

  it("partitions expiredTasks with the expirable overdue set: no overlap, no gap", () => {
    const batch = [
      rejectedWithDeadline("stuck-a", PAST),
      openWithDeadline("expirable-a", PAST),
      inReviewWithDeadline("expirable-b", PAST),
      disputedWithDeadline("stuck-b", PAST),
      draftWithDeadline("stuck-c", PAST),
      openWithDeadline("not-overdue", FUTURE),
      new TaskLifecycle("no-deadline"),
      abandonedWithDeadline("terminal", PAST),
    ];
    const expired = expiredTasks(batch, NOW);
    const stuck = stuckTasks(batch, NOW);
    const expirable = expired.filter((t) => !stuck.includes(t));

    assert.deepEqual(ids(expired), [
      "stuck-a",
      "expirable-a",
      "expirable-b",
      "stuck-b",
      "stuck-c",
    ]);
    assert.deepEqual(ids(stuck), ["stuck-a", "stuck-b", "stuck-c"]);
    assert.deepEqual(ids(expirable), ["expirable-a", "expirable-b"]);
    // No overlap: no task is both stuck and expirable.
    assert.equal(
      stuck.filter((t) => expirable.includes(t)).length,
      0,
    );
    // No gap: stuck + expirable covers the whole expired selection.
    assert.equal(stuck.length + expirable.length, expired.length);
  });

  it("the live executor agrees: every expired task either expires or is exactly the stuck set", () => {
    const batch = [
      rejectedWithDeadline("stuck-a", PAST),
      openWithDeadline("expirable-a", PAST),
      disputedWithDeadline("stuck-b", PAST),
      inReviewWithDeadline("expirable-b", PAST),
      draftWithDeadline("stuck-c", PAST),
    ];
    const stuckIds = ids(stuckTasks(batch, NOW));
    const before = batch.map((t) => t.history.length);

    const results = expireOverdueTasks(batch, NOW);

    assert.equal(results.length, 5);
    for (const result of results) {
      if (stuckIds.includes(result.task.id)) {
        assert.equal(result.expired, false);
        assert.equal(result.unexpirable, true);
        assert.equal("error" in result, false);
      } else {
        assert.equal(result.expired, true);
        assert.equal("unexpirable" in result, false);
        assert.equal("error" in result, false);
      }
    }
    // The stuck tasks are untouched; the expirable ones gained
    // exactly one EXPIRE entry each.
    assert.deepEqual(
      batch.map((t) => t.history.length),
      before.map((n, i) => (stuckIds.includes(batch[i].id) ? n : n + 1)),
    );
  });

  it("the dry run agrees: wouldExpire true exactly for the non-stuck expired set", () => {
    const batch = [
      disputedWithDeadline("stuck", PAST),
      openWithDeadline("expirable", PAST),
    ];
    const stuckIds = ids(stuckTasks(batch, NOW));

    const results = expireOverdueTasks(batch, NOW, undefined, {
      dryRun: true,
    });

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.expired, false);
      if (stuckIds.includes(result.task.id)) {
        assert.equal(result.wouldExpire, false);
        assert.equal(result.unexpirable, true);
        assert.equal("error" in result, false);
      } else {
        assert.equal(result.wouldExpire, true);
        assert.equal("unexpirable" in result, false);
        assert.equal(result.error, undefined);
      }
    }
    assert.deepEqual(
      batch.map((t) => t.state),
      ["DISPUTED", "OPEN"],
    );
  });

  it("returns an empty array for an empty batch", () => {
    assert.deepEqual(stuckTasks([], NOW), []);
  });

  it("fails fast on a malformed batch", () => {
    assert.throws(
      () => stuckTasks(null as unknown as TaskLifecycle[], NOW),
      /invalid stuckTasks: tasks must be an array, got null/,
    );
    assert.throws(
      () =>
        stuckTasks(
          [openWithDeadline("ok", PAST), null as unknown as TaskLifecycle],
          NOW,
        ),
      /invalid stuckTasks: tasks\[1\] must be a TaskLifecycle, got null/,
    );
  });

  it("fails fast on an invalid now", () => {
    const rejected = rejectedWithDeadline("rejected", PAST);
    assert.throws(
      () => stuckTasks([rejected], new Date("not-a-date")),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => stuckTasks([rejected], "2026-06-01" as unknown as Date),
      /invalid now: expected a valid Date/,
    );
  });
});
