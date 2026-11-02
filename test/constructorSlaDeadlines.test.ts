/**
 * Constructor-attached SLA deadlines (backlog #829).
 *
 * `TaskLifecycleOptions.slaDeadlines` attaches per-state deadlines up
 * front, with the same validation + canonical-ISO normalization as
 * `setSlaDeadline` — so a history-only rebuild via
 * `fromHistory(id, history, { slaDeadlines })` no longer needs a
 * hand-written set loop after replay (the old gap: deadlines were
 * the one piece of configuration that could not be re-attached
 * through opts, unlike rolePolicy/maxDisputes).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  isOverdue,
  expiredTasks,
} from "../src/index.js";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-10-04T00:00:00.000Z");

function acceptedTask(): TaskLifecycle {
  const t = new TaskLifecycle("task-csd-001");
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  return t;
}

test("constructor slaDeadlines: multi-state deadlines read back canonical ISO", () => {
  const t = new TaskLifecycle("task-csd-002", {
    slaDeadlines: {
      OPEN: "2026-06-01 00:00:00 UTC", // non-ISO input, still parseable
      ACCEPTED: new Date(FUTURE),
      CAPTURING: FUTURE,
    },
  });
  assert.equal(t.getSlaDeadline("OPEN"), "2026-06-01T00:00:00.000Z");
  assert.equal(t.getSlaDeadline("ACCEPTED"), FUTURE);
  assert.equal(t.getSlaDeadline("CAPTURING"), FUTURE);
  assert.equal(t.getSlaDeadline("DRAFT"), undefined);
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0); // attaching deadlines appends nothing
});

test("constructor slaDeadlines: isOverdue/expiredTasks agree with setSlaDeadline tasks", () => {
  const t = new TaskLifecycle("task-csd-003", {
    slaDeadlines: { ACCEPTED: PAST, OPEN: FUTURE },
  });
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  assert.equal(t.state, "ACCEPTED");
  assert.equal(isOverdue(t, NOW), true);
  assert.deepEqual(expiredTasks([t], NOW).map((x) => x.id), ["task-csd-003"]);

  const fresh = new TaskLifecycle("task-csd-004", {
    slaDeadlines: { ACCEPTED: FUTURE },
  });
  fresh.dispatch("PUBLISH", { actor: "researcher" });
  fresh.dispatch("ACCEPT", { actor: "contributor" });
  assert.equal(isOverdue(fresh, NOW), false);
  assert.deepEqual(expiredTasks([fresh], NOW), []);
});

test("constructor slaDeadlines: deadline for a non-current state is ignored by isOverdue", () => {
  const t = new TaskLifecycle("task-csd-005", {
    slaDeadlines: { OPEN: PAST },
  });
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  assert.equal(isOverdue(t, NOW), false);
  assert.equal(t.getSlaDeadline("OPEN"), PAST);
  assert.equal(t.getSlaDeadline("ACCEPTED"), undefined);
});

test("constructor slaDeadlines: unknown state throws and no task is created", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-006", {
        slaDeadlines: { NOPE: FUTURE } as never,
      }),
    /invalid option: slaDeadlines has unknown state NOPE/,
  );
});

test("constructor slaDeadlines: unparseable date throws and no task is created", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-007", {
        slaDeadlines: { OPEN: "not-a-date" },
      }),
    /invalid option: slaDeadlines\[OPEN\] is not a parseable date/,
  );
});

test("constructor slaDeadlines: Invalid Date throws and no task is created", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-008", {
        slaDeadlines: { OPEN: new Date("not-a-date") },
      }),
    /invalid option: slaDeadlines\[OPEN\] is not a parseable date/,
  );
});

test("constructor slaDeadlines: non-object map throws", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-009", {
        slaDeadlines: "2099-01-01" as never,
      }),
    /invalid option: slaDeadlines must be an object/,
  );
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-010", {
        slaDeadlines: [{ OPEN: FUTURE }] as never,
      }),
    /invalid option: slaDeadlines must be an object/,
  );
});

test("constructor slaDeadlines: non-Date/non-string value throws", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-011", {
        slaDeadlines: { OPEN: 20990101 } as never,
      }),
    /invalid option: slaDeadlines\[OPEN\] must be a Date or string/,
  );
});

test("constructor slaDeadlines: one bad entry rejects the whole map", () => {
  assert.throws(
    () =>
      new TaskLifecycle("task-csd-012", {
        slaDeadlines: { OPEN: FUTURE, ACCEPTED: "not-a-date" },
      }),
    /invalid option: slaDeadlines\[ACCEPTED\] is not a parseable date/,
  );
});

test("constructor slaDeadlines: omitted and empty maps behave like no deadlines", () => {
  const a = new TaskLifecycle("task-csd-013");
  assert.equal(a.getSlaDeadline("OPEN"), undefined);
  const b = new TaskLifecycle("task-csd-014", { slaDeadlines: {} });
  assert.equal(b.getSlaDeadline("OPEN"), undefined);
  assert.equal(isOverdue(b, NOW), false);
});

test("constructor slaDeadlines: fromHistory re-attaches deadlines and replay continues", () => {
  const live = acceptedTask();
  const log = live.history;
  const restored = TaskLifecycle.fromHistory("task-csd-001", log, {
    slaDeadlines: { ACCEPTED: PAST, CAPTURING: FUTURE },
  });
  assert.equal(restored.state, "ACCEPTED");
  assert.equal(restored.getSlaDeadline("ACCEPTED"), PAST);
  assert.equal(restored.getSlaDeadline("CAPTURING"), FUTURE);
  assert.equal(isOverdue(restored, NOW), true);
  // Replay continues cleanly: next dispatch links at seq 3, no gaps.
  restored.dispatch("START_CAPTURE", { actor: "contributor" });
  assert.equal(restored.state, "CAPTURING");
  assert.equal(restored.history.length, 3);
  assert.equal(restored.history[2].seq, 3);
  assert.equal(isOverdue(restored, NOW), false); // CAPTURING deadline is future
});

test("constructor slaDeadlines: fromHistory without the option restores no deadlines", () => {
  const live = acceptedTask();
  const restored = TaskLifecycle.fromHistory("task-csd-001", live.history);
  assert.equal(restored.state, "ACCEPTED");
  assert.equal(restored.getSlaDeadline("ACCEPTED"), undefined);
  assert.equal(isOverdue(restored, NOW), false);
});

test("constructor slaDeadlines: toJSON shape unchanged, snapshot round-trip keeps deadlines", () => {
  const t = new TaskLifecycle("task-csd-015", {
    slaDeadlines: { OPEN: PAST, ACCEPTED: FUTURE },
  });
  const snapshot = t.toJSON();
  assert.deepEqual(snapshot.slaDeadlines, { OPEN: PAST, ACCEPTED: FUTURE });
  const restored = TaskLifecycle.fromJSON(
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.equal(restored.getSlaDeadline("OPEN"), PAST);
  assert.equal(restored.getSlaDeadline("ACCEPTED"), FUTURE);
  assert.deepEqual(restored.toJSON(), snapshot);
});

test("constructor slaDeadlines: later setSlaDeadline overwrites a constructed deadline", () => {
  const t = new TaskLifecycle("task-csd-016", {
    slaDeadlines: { OPEN: FUTURE },
  });
  t.setSlaDeadline(PAST, "OPEN");
  assert.equal(t.getSlaDeadline("OPEN"), PAST);
  t.clearSlaDeadline("OPEN");
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
});

test("setSlaDeadline: unknown state now fails fast like the constructor", () => {
  const t = new TaskLifecycle("task-csd-017");
  assert.throws(
    () => t.setSlaDeadline(FUTURE, "NOPE" as never),
    /invalid SLA deadline: unknown state NOPE/,
  );
  assert.equal(t.getSlaDeadline("OPEN"), undefined);
});
