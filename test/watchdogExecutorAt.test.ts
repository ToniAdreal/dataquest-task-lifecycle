/**
 * Watchdog executors' `at` timestamp injection (backlog #925).
 *
 * `expireOverdueTasks()` and `actOnStaleTasks()` stamped their audit
 * entries with the wall clock even when the caller had pinned the
 * screening `now` — a deterministic replay could not get a
 * deterministic watchdog entry out of the default actions. Both
 * executors now take an optional `at?: Date | string` that pins the
 * audit timestamp; omitted, the wall clock applies as before.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  actOnStaleTasks,
  expireOverdueTasks,
} from "../src/index.js";

const NOW = new Date("2026-06-02T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");
const DAY = 24 * 3600_000;
const STALE_NOW = new Date("2026-03-22T09:00:00.000Z");
const STALE_BUDGETS = { ACCEPTED: 7 * DAY } as const;

/** OPEN task (has an EXPIRE edge) whose PUBLISH is stamped at `at`. */
function openTask(id: string, publishedAt: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "poster", at: publishedAt });
  return t;
}

/** ACCEPTED task (has an ABANDON edge) whose ACCEPT is stamped at `at`. */
function acceptedTask(id: string, acceptedAt: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher", at: "2026-02-01T09:00:00.000Z" });
  t.dispatch("ACCEPT", { actor: "contributor", at: acceptedAt });
  return t;
}

describe("expireOverdueTasks at", () => {
  it("pins the EXPIRE audit timestamp from a Date", () => {
    const t = openTask("pinned-date", "2026-05-01T09:00:00.000Z");
    t.setSlaDeadline(PAST);

    const results = expireOverdueTasks(
      [t],
      NOW,
      new Date("2026-05-15T12:00:00.000Z"),
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].expired, true);
    assert.equal(results[0].error, undefined);
    assert.equal(t.state, "EXPIRED");
    const last = t.history.at(-1)!;
    assert.deepEqual(
      [last.event, last.to, last.actor, last.at],
      ["EXPIRE", "EXPIRED", "system", "2026-05-15T12:00:00.000Z"],
    );
    assert.equal(results[0].entry?.at, "2026-05-15T12:00:00.000Z");
  });

  it("pins the EXPIRE audit timestamp from a canonical ISO string", () => {
    const t = openTask("pinned-string", "2026-05-01T09:00:00.000Z");
    t.setSlaDeadline(PAST);

    const results = expireOverdueTasks([t], NOW, "2026-05-20T08:30:00.000Z");
    assert.equal(results[0].expired, true);
    assert.equal(t.history.at(-1)!.at, "2026-05-20T08:30:00.000Z");
  });

  it("omitted at keeps the wall-clock stamp (no silent change)", () => {
    const t = openTask("wall-clock", "2026-05-01T09:00:00.000Z");
    t.setSlaDeadline(PAST);

    const results = expireOverdueTasks([t], NOW);
    assert.equal(results[0].expired, true);
    const last = t.history.at(-1)!;
    // Canonical ISO, and a real wall-clock instant: after the fixed
    // screening now, never the pinned value a caller would pass.
    assert.equal(new Date(last.at).toISOString(), last.at);
    assert.ok(Date.parse(last.at) >= NOW.getTime());
    assert.notEqual(last.at, "2026-05-15T12:00:00.000Z");
  });

  it("an at earlier than the last entry fails per task and the batch continues", () => {
    const early = openTask("early", "2026-06-01T09:00:00.000Z");
    early.setSlaDeadline(PAST);
    const late = openTask("late", "2026-05-01T09:00:00.000Z");
    late.setSlaDeadline(PAST);
    const lateBefore = JSON.stringify(late.history);

    const results = expireOverdueTasks(
      [early, late],
      NOW,
      "2026-05-15T00:00:00.000Z",
    );
    assert.equal(results.length, 2);

    const failed = results.find((r) => r.task.id === "early")!;
    assert.equal(failed.expired, false);
    assert.match(
      failed.error ?? "",
      /at 2026-05-15T00:00:00\.000Z is earlier than the previous entry's at 2026-06-01T09:00:00\.000Z/,
    );
    // The failed task is untouched: still OPEN, no new history.
    assert.equal(early.state, "OPEN");
    assert.equal(early.history.length, 1);
    assert.notEqual(JSON.stringify(late.history), lateBefore);

    const ok = results.find((r) => r.task.id === "late")!;
    assert.equal(ok.expired, true);
    assert.equal(late.state, "EXPIRED");
    assert.equal(late.history.at(-1)!.at, "2026-05-15T00:00:00.000Z");
  });

  it("an at equal to the last entry's at is allowed (non-decreasing)", () => {
    const t = openTask("equal", "2026-05-01T09:00:00.000Z");
    t.setSlaDeadline(PAST);

    const results = expireOverdueTasks([t], NOW, "2026-05-01T09:00:00.000Z");
    assert.equal(results[0].expired, true);
    assert.equal(t.history.at(-1)!.at, "2026-05-01T09:00:00.000Z");
  });

  it("an invalid at fails fast and touches no task", () => {
    const a = openTask("a", "2026-05-01T09:00:00.000Z");
    a.setSlaDeadline(PAST);
    const b = openTask("b", "2026-05-01T09:00:00.000Z");
    b.setSlaDeadline(PAST);
    const before = [a, b].map((t) => JSON.stringify(t.history));

    // Non-canonical string, invalid Date, and a non-string value:
    // each throws before any screening or dispatch.
    assert.throws(
      () => expireOverdueTasks([a, b], NOW, "2026-05-15"),
      /invalid at: expected a canonical ISO-8601 string or a valid Date, got "2026-05-15"/,
    );
    assert.throws(
      () => expireOverdueTasks([a, b], NOW, new Date("not-a-date")),
      /invalid at: expected a valid Date/,
    );
    assert.throws(
      () => expireOverdueTasks([a, b], NOW, 123 as never),
      /invalid at: expected a canonical ISO-8601 string or a valid Date, got 123/,
    );
    assert.deepEqual(
      [a, b].map((t) => JSON.stringify(t.history)),
      before,
    );
    assert.deepEqual(
      [a, b].map((t) => t.state),
      ["OPEN", "OPEN"],
    );
  });
});

describe("actOnStaleTasks at", () => {
  it("pins the default ABANDON audit timestamp from a Date", () => {
    const t = acceptedTask("pinned-date", "2026-03-05T09:00:00.000Z");

    const results = actOnStaleTasks(
      [t],
      undefined,
      STALE_BUDGETS,
      STALE_NOW,
      new Date("2026-03-22T09:00:00.000Z"),
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].acted, true);
    assert.equal(t.state, "ABANDONED");
    const last = t.history.at(-1)!;
    assert.deepEqual(
      [last.event, last.to, last.actor, last.at],
      ["ABANDON", "ABANDONED", "system", "2026-03-22T09:00:00.000Z"],
    );
    assert.equal(results[0].entry?.at, "2026-03-22T09:00:00.000Z");
  });

  it("pins the default ABANDON audit timestamp from a canonical ISO string", () => {
    const t = acceptedTask("pinned-string", "2026-03-05T09:00:00.000Z");

    const results = actOnStaleTasks(
      [t],
      undefined,
      STALE_BUDGETS,
      STALE_NOW,
      "2026-03-21T10:00:00.000Z",
    );
    assert.equal(results[0].acted, true);
    assert.equal(t.history.at(-1)!.at, "2026-03-21T10:00:00.000Z");
  });

  it("an at earlier than the last entry fails per task and the batch continues", () => {
    const early = acceptedTask("early", "2026-03-05T09:00:00.000Z");
    const late = acceptedTask("late", "2026-02-28T09:00:00.000Z");

    const results = actOnStaleTasks(
      [early, late],
      undefined,
      STALE_BUDGETS,
      STALE_NOW,
      "2026-03-01T00:00:00.000Z",
    );
    assert.equal(results.length, 2);

    const failed = results.find((r) => r.task.id === "early")!;
    assert.equal(failed.acted, false);
    assert.match(
      failed.error ?? "",
      /at 2026-03-01T00:00:00\.000Z is earlier than the previous entry's at 2026-03-05T09:00:00\.000Z/,
    );
    assert.equal(early.state, "ACCEPTED");
    assert.equal(early.history.length, 2);

    const ok = results.find((r) => r.task.id === "late")!;
    assert.equal(ok.acted, true);
    assert.equal(late.state, "ABANDONED");
    assert.equal(late.history.at(-1)!.at, "2026-03-01T00:00:00.000Z");
  });

  it("an invalid at fails fast and touches no task", () => {
    const t = acceptedTask("untouched", "2026-03-05T09:00:00.000Z");
    const before = JSON.stringify(t.history);

    assert.throws(
      () =>
        actOnStaleTasks(
          [t],
          undefined,
          STALE_BUDGETS,
          STALE_NOW,
          "2026-03-22 09:00" as never,
        ),
      /invalid at:/,
    );
    assert.throws(
      () =>
        actOnStaleTasks(
          [t],
          undefined,
          STALE_BUDGETS,
          STALE_NOW,
          new Date(Number.NaN),
        ),
      /invalid at: expected a valid Date/,
    );
    assert.equal(JSON.stringify(t.history), before);
    assert.equal(t.state, "ACCEPTED");
  });

  it("at is ignored by a custom action, which stamps its own timestamp", () => {
    const t = acceptedTask("custom", "2026-03-05T09:00:00.000Z");

    const results = actOnStaleTasks(
      [t],
      (task) =>
        task.dispatch("ABANDON", {
          actor: "watchdog",
          at: "2026-03-10T09:00:00.000Z",
        }),
      STALE_BUDGETS,
      STALE_NOW,
      "2026-03-01T00:00:00.000Z",
    );
    assert.equal(results[0].acted, true);
    // The executor's at never leaks into a dispatch it does not make:
    // the entry carries the custom action's own timestamp and actor.
    const last = t.history.at(-1)!;
    assert.deepEqual(
      [last.event, last.actor, last.at],
      ["ABANDON", "watchdog", "2026-03-10T09:00:00.000Z"],
    );
  });

  it("an at equal to the last entry's at is allowed (non-decreasing)", () => {
    const t = acceptedTask("equal", "2026-03-05T09:00:00.000Z");

    const results = actOnStaleTasks(
      [t],
      undefined,
      STALE_BUDGETS,
      STALE_NOW,
      "2026-03-05T09:00:00.000Z",
    );
    assert.equal(results[0].acted, true);
    assert.equal(t.history.at(-1)!.at, "2026-03-05T09:00:00.000Z");
  });
});
