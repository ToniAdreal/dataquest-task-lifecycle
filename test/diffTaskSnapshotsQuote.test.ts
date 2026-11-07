import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  diffTaskSnapshots,
} from "../src/index.js";
import type { DispatchOptions, TaskSnapshot } from "../src/index.js";

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string, acceptOpts: DispatchOptions = {}): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor", ...acceptOpts });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  acceptOpts: DispatchOptions = {},
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toApproved(id, acceptOpts);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

/** Deep clone a snapshot through JSON (snapshots are plain JSON). */
function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
}

test("diffTaskSnapshots: ACCEPT reports quote change from undefined to the quoted amount", () => {
  const task = new TaskLifecycle("t-quote");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 2500 });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.quoteChanged, { from: undefined, to: 2500 });
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "ACCEPTED" });
  assert.equal(diff.payoutChanged, undefined);
});

test("diffTaskSnapshots: identical quotes in both snapshots report no quoteChanged", () => {
  const task = toApproved("t-same-quote", { quotedAmount: 2500 });
  const before = task.toJSON();
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.quoteChanged, undefined);
  assert.equal(diff.payoutChanged, undefined);
  assert.deepEqual(diff.stateChanged, {
    from: "APPROVED",
    to: "PAYOUT_PENDING",
  });
});

test("diffTaskSnapshots: a task accepted without a quote never reports quoteChanged", () => {
  const task = toPaid("t-no-quote");
  // Re-diff the whole lifecycle against a fresh snapshot: no ACCEPT
  // ever carried a quote, so the quote dimension stays silent even
  // though state and history all moved (and no payout amount was
  // recorded either, so payoutChanged stays silent too).
  const fresh = new TaskLifecycle("t-no-quote").toJSON();
  const diff = diffTaskSnapshots(fresh, task.toJSON());
  assert.equal(diff.quoteChanged, undefined);
  assert.equal(diff.payoutChanged, undefined);
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "PAID" });
});

test("diffTaskSnapshots: ACCEPT without quotedAmount reports no quoteChanged", () => {
  const task = new TaskLifecycle("t-accept-no-quote");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.quoteChanged, undefined);
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "ACCEPTED" });
});

test("diffTaskSnapshots: rehydrated snapshots report the same quote change", () => {
  const task = new TaskLifecycle("t-rehydrated");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 2500 });
  const after = task.toJSON();
  const liveDiff = diffTaskSnapshots(before, after);
  const restoredBefore = TaskLifecycle.fromJSON(cloneSnapshot(before));
  const restoredAfter = TaskLifecycle.fromJSON(cloneSnapshot(after));
  const rehydratedDiff = diffTaskSnapshots(
    restoredBefore.toJSON(),
    restoredAfter.toJSON(),
  );
  assert.deepEqual(rehydratedDiff, liveDiff);
  assert.deepEqual(rehydratedDiff.quoteChanged, {
    from: undefined,
    to: 2500,
  });
});

test("diffTaskSnapshots: settlement-only change reports payoutChanged, not quoteChanged", () => {
  const task = toApproved("t-settle-only", { quotedAmount: 2500 });
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = task.toJSON();
  task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 2500,
  });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.payoutChanged, { from: undefined, to: 2500 });
  assert.equal(diff.quoteChanged, undefined);
  assert.deepEqual(diff.stateChanged, {
    from: "PAYOUT_PENDING",
    to: "PAID",
  });
});

test("diffTaskSnapshots: quote survives to PAID unchanged while payout lands", () => {
  const task = toApproved("t-quote-paid", { quotedAmount: 2500 });
  const before = task.toJSON();
  task.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  task.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-1",
    payoutAmount: 2400,
  });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.quoteChanged, undefined);
  assert.deepEqual(diff.payoutChanged, { from: undefined, to: 2400 });
});

test("diffTaskSnapshots: a quote of 0 is distinct from no quote", () => {
  const task = new TaskLifecycle("t-quote-zero");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 0 });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.quoteChanged, { from: undefined, to: 0 });
});

test("diffTaskSnapshots: identical snapshots carrying a quote diff to an empty object", () => {
  const task = toApproved("t-quote-same", { quotedAmount: 2500 });
  assert.deepEqual(
    diffTaskSnapshots(task.toJSON(), task.toJSON()),
    {},
  );
});

test("diffTaskSnapshots: quote change coexists with state and history appends", () => {
  const task = new TaskLifecycle("t-quote-full");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { actor: "researcher" });
  task.dispatch("ACCEPT", { actor: "contributor", quotedAmount: 2500 });
  task.dispatch("START_CAPTURE", { actor: "contributor" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.deepEqual(diff.quoteChanged, { from: undefined, to: 2500 });
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "CAPTURING" });
  assert.equal(diff.historyAppended?.fromSeq, 1);
  assert.equal(diff.historyAppended?.toSeq, 3);
  assert.deepEqual(
    diff.historyAppended?.entries.map((entry) => entry.event),
    ["PUBLISH", "ACCEPT", "START_CAPTURE"],
  );
  assert.equal(diff.payoutChanged, undefined);
  assert.equal(diff.slaChanged, undefined);
});
