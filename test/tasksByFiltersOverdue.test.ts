/**
 * tasksByFilters overdue axis (backlog #1049, mirrors escrow #1048).
 *
 * `tasksByFilters()` had state/actor/event/payoutRef axes only, so a
 * board that wanted "overdue tasks the moderator disputed" had to
 * screen with `expiredTasks()` and intersect by hand — and the
 * hand-written intersection had no shared answer for the deadline
 * boundary, for terminal tasks, or for a task with no deadline at
 * all. The `overdue` axis reuses `isOverdue()`'s rule exactly (past
 * SLA deadline, non-terminal, boundary `now >= deadline`
 * inclusive), with `now` injectable as a third argument so tests pin
 * the screening instant.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, tasksByFilters } from "../src/index.js";
import type { DispatchOptions } from "../src/index.js";

const PAST = new Date("2026-01-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const NOW = new Date("2026-06-01T00:00:00.000Z");
// Far-apart dates so the real clock decides unambiguously.
const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");

/** Drive a task from DRAFT to OPEN. */
function toOpen(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  assert.equal(t.state, "OPEN");
  return t;
}

/** Drive a task from DRAFT to IN_REVIEW. */
function toInReview(id: string, reviewActor = "reviewer"): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: reviewActor });
  assert.equal(t.state, "IN_REVIEW");
  return t;
}

/** Drive a task from DRAFT to DISPUTED, disputed by the given actor. */
function toDisputed(id: string, disputeActor = "moderator"): TaskLifecycle {
  const t = toInReview(id);
  t.dispatch("REJECT", { actor: "reviewer" });
  t.dispatch("DISPUTE", { actor: disputeActor });
  assert.equal(t.state, "DISPUTED");
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toInReview(id);
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

/** Drive a task from DRAFT to ABANDONED. */
function toAbandoned(id: string): TaskLifecycle {
  const t = toOpen(id);
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("ABANDON", { actor: "contributor" });
  assert.equal(t.state, "ABANDONED");
  return t;
}

/** An OPEN task carrying a deadline on its current state. */
function openWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const t = toOpen(id);
  t.setSlaDeadline(deadline);
  return t;
}

/** A DISPUTED task carrying a deadline on its current state. */
function disputedWithDeadline(id: string, deadline: Date): TaskLifecycle {
  const t = toDisputed(id);
  t.setSlaDeadline(deadline);
  return t;
}

function byId(tasks: TaskLifecycle[]): string[] {
  return tasks.map((t) => t.id);
}

describe("tasksByFilters overdue axis", () => {
  it("overdue:true selects only past-deadline non-terminal tasks", () => {
    const overdue = openWithDeadline("overdue", PAST);
    const disputed = disputedWithDeadline("disputed", PAST);
    const notOverdue = openWithDeadline("not-overdue", FUTURE);
    const noDeadline = toOpen("no-deadline");
    const paid = toPaid("paid", { payoutRef: "xfer-88f2" });
    paid.setSlaDeadline(PAST, "PAID");
    const abandoned = toAbandoned("abandoned");
    abandoned.setSlaDeadline(PAST, "ABANDONED");

    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdue, disputed, notOverdue, noDeadline, paid, abandoned],
          { overdue: true },
          NOW,
        ),
      ),
      ["overdue", "disputed"],
    );
  });

  it("a deadline exactly at now counts as overdue (boundary inclusive)", () => {
    const atBoundary = openWithDeadline("at-boundary", NOW);
    const justAhead = openWithDeadline(
      "just-ahead",
      new Date(NOW.getTime() + 1),
    );

    assert.deepEqual(
      byId(tasksByFilters([atBoundary, justAhead], { overdue: true }, NOW)),
      ["at-boundary"],
    );
    assert.deepEqual(
      byId(tasksByFilters([atBoundary, justAhead], { overdue: false }, NOW)),
      ["just-ahead"],
    );
  });

  it("a task with no deadline never matches overdue:true", () => {
    const noDeadline = toOpen("no-deadline");
    assert.deepEqual(
      byId(tasksByFilters([noDeadline], { overdue: true }, NOW)),
      [],
    );
    assert.deepEqual(
      byId(tasksByFilters([noDeadline], { overdue: false }, NOW)),
      ["no-deadline"],
    );
  });

  it("a terminal task never matches overdue:true even past its deadline", () => {
    const paid = toPaid("paid", { payoutRef: "xfer-88f2" });
    paid.setSlaDeadline(PAST, "PAID");
    const abandoned = toAbandoned("abandoned");
    abandoned.setSlaDeadline(PAST, "ABANDONED");

    assert.deepEqual(
      byId(tasksByFilters([paid, abandoned], { overdue: true }, NOW)),
      [],
    );
    assert.deepEqual(
      byId(tasksByFilters([paid, abandoned], { overdue: false }, NOW)),
      ["paid", "abandoned"],
    );
  });

  it("overdue:false selects the complement: not overdue, no deadline, terminal", () => {
    const overdue = openWithDeadline("overdue", PAST);
    const notOverdue = openWithDeadline("not-overdue", FUTURE);
    const noDeadline = toOpen("no-deadline");
    const paid = toPaid("paid", { payoutRef: "xfer-88f2" });
    paid.setSlaDeadline(PAST, "PAID");

    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdue, notOverdue, noDeadline, paid],
          { overdue: false },
          NOW,
        ),
      ),
      ["not-overdue", "no-deadline", "paid"],
    );
  });

  it("overdue intersects with the state, actor, event, and payoutRef axes", () => {
    const overdueDisputed = disputedWithDeadline("overdue-disputed", PAST);
    const overdueOpen = openWithDeadline("overdue-open", PAST);
    const freshDisputed = disputedWithDeadline("fresh-disputed", FUTURE);
    const paid = toPaid("paid", { payoutRef: "xfer-88f2" });

    // Overdue + DISPUTED + moderator + DISPUTE: only the overdue dispute.
    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdueDisputed, overdueOpen, freshDisputed, paid],
          {
            state: "DISPUTED",
            actor: "moderator",
            event: "DISPUTE",
            overdue: true,
          },
          NOW,
        ),
      ),
      ["overdue-disputed"],
    );
    // The payoutRef axis still intersects: a PAID task is terminal, so
    // it only ever matches overdue:false.
    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdueDisputed, overdueOpen, freshDisputed, paid],
          { payoutRef: "xfer-88f2", overdue: false },
          NOW,
        ),
      ),
      ["paid"],
    );
    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdueDisputed, overdueOpen, freshDisputed, paid],
          { payoutRef: "xfer-88f2", overdue: true },
          NOW,
        ),
      ),
      [],
    );
  });

  it("an empty condition object still selects every task", () => {
    const overdue = openWithDeadline("overdue", PAST);
    const notOverdue = openWithDeadline("not-overdue", FUTURE);
    const paid = toPaid("paid", { payoutRef: "xfer-88f2" });

    assert.deepEqual(
      byId(tasksByFilters([overdue, notOverdue, paid], {}, NOW)),
      ["overdue", "not-overdue", "paid"],
    );
  });

  it("omitting overdue leaves the deadline out of the match entirely", () => {
    const overdue = openWithDeadline("overdue", PAST);
    const notOverdue = openWithDeadline("not-overdue", FUTURE);

    assert.deepEqual(
      byId(
        tasksByFilters([overdue, notOverdue], { state: "OPEN" }, NOW),
      ),
      ["overdue", "not-overdue"],
    );
  });

  it("an unknown filter key still throws fail-closed", () => {
    const overdue = openWithDeadline("overdue", PAST);
    assert.throws(
      () =>
        tasksByFilters(
          [overdue],
          // @ts-expect-error deliberate typo: the fail-closed key check.
          { overdue: true, states: "OPEN" },
          NOW,
        ),
      /invalid tasksByFilters: unknown filter "states"/,
    );
  });

  it("a non-boolean overdue value throws fail-closed", () => {
    const overdue = openWithDeadline("overdue", PAST);
    for (const bad of ["yes", 1, 0, null]) {
      assert.throws(
        () =>
          tasksByFilters(
            [overdue],
            // @ts-expect-error deliberate bad value: the boolean check.
            { overdue: bad },
            NOW,
          ),
        /invalid tasksByFilters: overdue must be a boolean/,
      );
    }
    // No task is touched by the throw: the batch is unchanged.
    assert.equal(overdue.state, "OPEN");
  });

  it("an invalid now throws fail-fast when the overdue axis is present", () => {
    const overdue = openWithDeadline("overdue", PAST);
    assert.throws(
      () =>
        tasksByFilters([overdue], { overdue: true }, new Date("not-a-date")),
      /invalid now: expected a valid Date/,
    );
    // Without the axis the screening instant is lazy: an invalid now
    // is never read, so the same call still filters normally.
    assert.deepEqual(
      byId(
        tasksByFilters(
          [overdue],
          { state: "OPEN" },
          new Date("not-a-date"),
        ),
      ),
      ["overdue"],
    );
  });

  it("without an explicit now the real clock decides (far past vs far future deadlines)", () => {
    const overdue = openWithDeadline("overdue", FAR_PAST);
    const notOverdue = openWithDeadline("not-overdue", FAR_FUTURE);
    assert.deepEqual(
      byId(tasksByFilters([overdue, notOverdue], { overdue: true })),
      ["overdue"],
    );
    assert.deepEqual(
      byId(tasksByFilters([overdue, notOverdue], { overdue: false })),
      ["not-overdue"],
    );
  });
});
