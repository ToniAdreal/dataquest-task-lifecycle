/**
 * `isOverdue` / `expiredTasks` fail fast on an invalid `now`
 * (backlog #1334).
 *
 * Decision recorded here: this item overturns #1248's silent-empty
 * decision for the watchdog path and aligns with escrow #1259. A
 * watchdog that silently reports "nothing overdue" when its clock is
 * broken is a false-negative safety failure — the same failure mode
 * the clock-hardening series (#1288-#1333) eliminated from every
 * other `now` entry in this file — and #1248's stated goal (never a
 * bare RangeError) is preserved by the guard, which throws a config
 * error before any `toISOString()` runs. `expireOverdueTasks` and
 * the `overdue` axis of `tasksByFilters` inherit the guard through
 * the single `isOverdue` funnel.
 *
 * One correction to the item's acceptance: it lists "an `undefined`
 * passed as `Date`" among the shapes that must throw. That cannot
 * throw: the `now` parameters carry a `new Date()` default, so an
 * explicit `undefined` is indistinguishable from omission and the
 * guard only ever sees a real Date. The `undefined` cases below pin
 * that default-parameter behaviour instead (real clock decides, no
 * throw).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  expireOverdueTasks,
  expiredTasks,
  isOverdue,
  tasksByFilters,
} from "../src/index.js";

const DEADLINE = "2026-03-02T09:00:00.000Z";
const AFTER = new Date("2026-03-05T09:00:00.000Z");
const AT_DEADLINE = new Date(DEADLINE);
const BEFORE = new Date("2026-03-01T09:00:00.000Z");
const LATER_AT = new Date("2026-03-06T09:00:00.000Z");
// Fixture audit timestamps: pinned before every screening instant, so
// the screening `now` never trips the non-decreasing-timestamp check.
const PUBLISH_AT = "2026-03-01T09:00:00.000Z";
const EXPIRE_AT = "2026-03-01T10:00:00.000Z";

/** OPEN task with an SLA deadline on its current state. */
function openTask(id: string, deadline: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  t.setSlaDeadline(deadline);
  return t;
}

/** OPEN task with no SLA deadline for its current state. */
function openTaskNoDeadline(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: PUBLISH_AT });
  return t;
}

/** Terminal (EXPIRED) task whose deadline is in the past. */
function terminalTask(id: string): TaskLifecycle {
  const t = openTask(id, DEADLINE);
  t.dispatch("EXPIRE", { actor: "system", at: EXPIRE_AT });
  return t;
}

describe("isOverdue fails fast on an invalid now (#1334)", () => {
  it("an invalid Date throws invalid now", () => {
    const task = openTask("invalid-date", DEADLINE);
    assert.throws(
      () => isOverdue(task, new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => isOverdue(task, new Date("not-a-date")),
      /invalid now: expected a valid Date/,
    );
  });

  it("a non-Date now throws the config error, never a bare TypeError", () => {
    const task = openTask("non-date-now", DEADLINE);
    for (const bad of ["2026-03-05", null, 42, {}]) {
      assert.throws(
        () => isOverdue(task, bad as never),
        /invalid now: expected a valid Date/,
        `now=${JSON.stringify(bad)}`,
      );
    }
  });

  it("an invalid now throws even when the task has no deadline or is terminal", () => {
    // The guard sits at the top of isOverdue, before the
    // no-deadline / terminal short-circuits: a broken clock must not
    // hide behind a task that would answer false anyway.
    const noDeadline = openTaskNoDeadline("no-deadline");
    const terminal = terminalTask("terminal");
    assert.throws(
      () => isOverdue(noDeadline, new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => isOverdue(terminal, new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
  });

  it("undefined now falls back to the real clock (default parameter, no throw)", () => {
    // Correction to the item's acceptance: an explicit `undefined`
    // triggers the `new Date()` default, so it cannot throw — the
    // guard only ever sees a real Date. Pin the behaviour instead:
    // past deadline is overdue, future deadline is not, both against
    // the real clock (2026-11-22 at authoring time, well past
    // 2026-03-02 and well before 2027-01-01).
    const past = openTask("undefined-now-past", DEADLINE);
    const future = openTask("undefined-now-future", "2027-01-01T09:00:00.000Z");
    assert.equal(isOverdue(past, undefined), true);
    assert.equal(isOverdue(future, undefined), false);
  });
});

describe("expiredTasks fails fast on an invalid now (#1334)", () => {
  it("an invalid Date throws, including for an empty batch", () => {
    const task = openTask("expired-invalid", DEADLINE);
    assert.throws(
      () => expiredTasks([task], new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    // An empty batch never reaches isOverdue through the filter, so
    // the guard is checked here too — otherwise [] would silently
    // screen as "nothing overdue" under a broken clock.
    assert.throws(
      () => expiredTasks([], new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
  });

  it("a non-Date now throws", () => {
    const task = openTask("expired-non-date", DEADLINE);
    assert.throws(
      () => expiredTasks([task], "2026-03-05" as never),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => expiredTasks([], null as never),
      /invalid now: expected a valid Date/,
    );
  });

  it("a valid now still filters the batch normally", () => {
    const overdue = openTask("overdue", DEADLINE);
    const notOverdue = openTask("not-overdue", "2026-03-10T09:00:00.000Z");
    const terminal = terminalTask("terminal-batch");
    const noDeadline = openTaskNoDeadline("no-deadline-batch");
    assert.deepEqual(
      expiredTasks([overdue, notOverdue, terminal, noDeadline], AFTER).map(
        (t) => t.id,
      ),
      ["overdue"],
    );
  });
});

describe("isOverdue legal-now behaviour is unchanged (#1334)", () => {
  it("overdue / not yet due / boundary / terminal / no deadline", () => {
    const overdue = openTask("legal-overdue", DEADLINE);
    const notOverdue = openTask("legal-not-overdue", "2026-03-10T09:00:00.000Z");
    const terminal = terminalTask("legal-terminal");
    const noDeadline = openTaskNoDeadline("legal-no-deadline");
    assert.equal(isOverdue(overdue, AFTER), true);
    assert.equal(isOverdue(overdue, BEFORE), false);
    assert.equal(isOverdue(notOverdue, AFTER), false);
    // Boundary is inclusive: now == deadline counts as overdue.
    assert.equal(isOverdue(overdue, AT_DEADLINE), true);
    assert.equal(isOverdue(terminal, AFTER), false);
    assert.equal(isOverdue(noDeadline, AFTER), false);
  });
});

describe("expireOverdueTasks inherits the fail-fast guard (#1334)", () => {
  it("an invalid now throws before any dispatch (live run)", () => {
    const task = openTask("executor-live", DEADLINE);
    const before = JSON.stringify(task.history);
    assert.throws(
      () => expireOverdueTasks([task], new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    assert.equal(task.state, "OPEN");
    assert.equal(JSON.stringify(task.history), before);
  });

  it("an invalid now throws before any prediction (dry run)", () => {
    const task = openTask("executor-dry", DEADLINE);
    const before = JSON.stringify(task.history);
    assert.throws(
      () =>
        expireOverdueTasks([task], new Date(Number.NaN), undefined, {
          dryRun: true,
        }),
      /invalid now: expected a valid Date/,
    );
    assert.equal(task.state, "OPEN");
    assert.equal(JSON.stringify(task.history), before);
  });

  it("an invalid now throws even with an explicit at pin, and for an empty batch", () => {
    const task = openTask("executor-pinned", DEADLINE);
    // The pin no longer short-circuits the screening instant: #1248's
    // "explicit at screens nothing" reading is overturned with it.
    assert.throws(
      () => expireOverdueTasks([task], new Date(Number.NaN), LATER_AT),
      /invalid now: expected a valid Date/,
    );
    assert.throws(
      () => expireOverdueTasks([], new Date(Number.NaN)),
      /invalid now: expected a valid Date/,
    );
    assert.equal(task.state, "OPEN");
  });

  it("a valid now still expires the batch with the screening now as the pin", () => {
    const task = openTask("executor-valid", DEADLINE);
    const [result] = expireOverdueTasks([task], AFTER);
    assert.equal(result.expired, true);
    assert.equal(result.error, undefined);
    assert.equal(result.entry?.at, AFTER.toISOString());
    assert.equal(task.state, "EXPIRED");
  });
});

describe("tasksByFilters overdue axis rejects a non-Date now (#1334)", () => {
  it("a string now throws invalid now instead of a bare TypeError", () => {
    const overdue = openTask("filters-string-now", DEADLINE);
    assert.throws(
      () =>
        tasksByFilters([overdue], { overdue: true }, "2026-03-05" as never),
      /invalid now: expected a valid Date/,
    );
  });
});
