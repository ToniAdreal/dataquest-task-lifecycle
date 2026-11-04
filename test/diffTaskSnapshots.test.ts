import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, diffTaskSnapshots } from "../src/index.js";
import type { DispatchOptions, TaskSnapshot } from "../src/index.js";

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

/** Deep clone a snapshot through JSON (snapshots are plain JSON). */
function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
}

test("diffTaskSnapshots: identical snapshots diff to an empty object", () => {
  const task = toPaid("t-same", {
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  task.setSlaDeadline("2026-12-01T00:00:00.000Z", "PAID");
  assert.deepEqual(
    diffTaskSnapshots(task.toJSON(), task.toJSON()),
    {},
  );
});

test("diffTaskSnapshots: one dispatch reports state change and the appended entry", () => {
  const task = new TaskLifecycle("t-one");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "OPEN" });
  assert.equal(diff.historyAppended?.fromSeq, 1);
  assert.equal(diff.historyAppended?.toSeq, 1);
  assert.equal(diff.historyAppended?.entries.length, 1);
  assert.equal(diff.historyAppended?.entries[0].event, "PUBLISH");
  assert.equal(diff.historyAppended?.entries[0].seq, 1);
  assert.equal(diff.payoutChanged, undefined);
  assert.equal(diff.slaChanged, undefined);
});

test("diffTaskSnapshots: several dispatches report the full appended range in order", () => {
  const task = new TaskLifecycle("t-many");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor" });
  task.dispatch("START_CAPTURE", { actor: "contributor" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "CAPTURING" });
  assert.equal(diff.historyAppended?.fromSeq, 1);
  assert.equal(diff.historyAppended?.toSeq, 3);
  assert.deepEqual(
    diff.historyAppended?.entries.map((entry) => entry.event),
    ["PUBLISH", "ACCEPT", "START_CAPTURE"],
  );
});

test("diffTaskSnapshots: payout completion reports payout change from undefined", () => {
  const task = toApproved("t-payout");
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = task.toJSON();
  task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-9",
    payoutAmount: 250,
  });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.stateChanged, {
    from: "PAYOUT_PENDING",
    to: "PAID",
  });
  assert.deepEqual(diff.payoutChanged, { from: undefined, to: 250 });
  assert.equal(diff.historyAppended?.entries[0].event, "PAYOUT_COMPLETE");
});

test("diffTaskSnapshots: a PAYOUT_COMPLETE without an amount leaves payout undefined", () => {
  const task = toApproved("t-noamount");
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = task.toJSON();
  task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-10",
  });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.payoutChanged, undefined);
});

test("diffTaskSnapshots: setting a deadline reports only the SLA change", () => {
  const task = toPaid("t-sla", {
    payoutRef: "xfer-2",
    payoutAmount: 100,
  });
  const before = task.toJSON();
  task.setSlaDeadline("2026-12-01T00:00:00.000Z", "PAID");
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff, {
    slaChanged: {
      from: {},
      to: { PAID: "2026-12-01T00:00:00.000Z" },
    },
  });
});

test("diffTaskSnapshots: changing then clearing a deadline reports both maps", () => {
  const task = new TaskLifecycle("t-sla-change");
  task.setSlaDeadline("2026-12-01T00:00:00.000Z", "DRAFT");
  const before = task.toJSON();
  task.setSlaDeadline("2027-01-15T00:00:00.000Z", "DRAFT");
  const changed = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(changed.slaChanged, {
    from: { DRAFT: "2026-12-01T00:00:00.000Z" },
    to: { DRAFT: "2027-01-15T00:00:00.000Z" },
  });
  assert.equal(changed.stateChanged, undefined);
  assert.equal(changed.historyAppended, undefined);
  const mid = task.toJSON();
  task.clearSlaDeadline("DRAFT");
  assert.deepEqual(diffTaskSnapshots(mid, task.toJSON()).slaChanged, {
    from: { DRAFT: "2027-01-15T00:00:00.000Z" },
    to: {},
  });
});

test("diffTaskSnapshots: SLA map key order is not a change", () => {
  const a = new TaskLifecycle("t-order", {
    slaDeadlines: {
      OPEN: "2026-12-01T00:00:00.000Z",
      DRAFT: "2026-11-01T00:00:00.000Z",
    },
  });
  const b = new TaskLifecycle("t-order", {
    slaDeadlines: {
      DRAFT: "2026-11-01T00:00:00.000Z",
      OPEN: "2026-12-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {});
});

test("diffTaskSnapshots: a rewritten history entry throws a divergence error", () => {
  const task = toApproved("t-rewrite");
  const before = task.toJSON();
  const after = cloneSnapshot(task.toJSON());
  after.history[0].note = "rewritten after the fact";
  assert.throws(
    () => diffTaskSnapshots(before, after),
    /snapshot diff failed: history of task "t-rewrite" diverged at entry 1/,
  );
});

test("diffTaskSnapshots: a truncated history throws a divergence error", () => {
  const task = toApproved("t-truncated");
  const before = task.toJSON();
  const after = cloneSnapshot(task.toJSON());
  after.history = after.history.slice(0, -1);
  assert.throws(
    () => diffTaskSnapshots(before, after),
    /snapshot diff failed: history of task "t-truncated" diverged at entry \d+/,
  );
});

test("diffTaskSnapshots: an appended entry that breaks seq continuity throws", () => {
  const task = new TaskLifecycle("t-gap");
  task.dispatch("PUBLISH", { actor: "researcher" });
  const before = task.toJSON();
  const after = cloneSnapshot(task.toJSON());
  const last = after.history[after.history.length - 1];
  after.history.push({ ...last, seq: last.seq + 2 });
  assert.throws(
    () => diffTaskSnapshots(before, after),
    /snapshot diff failed: history of task "t-gap" diverged at appended entry seq \d+ \(expected \d+;/,
  );
});

test("diffTaskSnapshots: snapshots of different tasks throw", () => {
  const a = new TaskLifecycle("t-a");
  const b = new TaskLifecycle("t-b");
  assert.throws(
    () => diffTaskSnapshots(a.toJSON(), b.toJSON()),
    /snapshot diff failed: cannot diff snapshots of different tasks \("t-a" vs "t-b"\)/,
  );
});

test("diffTaskSnapshots: pure — inputs untouched and returned entries are copies", () => {
  const task = new TaskLifecycle("t-pure");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  const after = task.toJSON();
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const diff = diffTaskSnapshots(before, after);
  assert.equal(JSON.stringify(before), beforeJson);
  assert.equal(JSON.stringify(after), afterJson);
  const entry = diff.historyAppended!.entries[0];
  entry.note = "mutated by the caller";
  assert.equal(after.history[0].note, undefined);
  assert.deepEqual(
    diffTaskSnapshots(before, after).historyAppended?.entries[0].note,
    undefined,
  );
});
