/**
 * Snapshot diff dimension `idempotencyKeysChanged` (backlog #963).
 *
 * The consumed idempotency-key set is part of the snapshot, but
 * `diffTaskSnapshots` never compared it — a key consumed (or
 * dropped on restore) between two stored snapshots was invisible
 * in the diff. The set is compared order-insensitively; a snapshot
 * without the field (legacy, or no key consumed yet) is the empty
 * set. This is the task-snapshot counterpart to the escrow repo's
 * `diffEscrowSnapshots` dimension of the same name (backlog #959).
 *
 * The consumed-key set is task state, not fixed configuration: it
 * grows with every keyed dispatch, which is why it is reported here
 * while the budgets and the role policy stay excluded (see
 * `test/diffTaskSnapshotsConfig.test.ts`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, diffTaskSnapshots } from "../src/index.js";
import type { TaskSnapshot } from "../src/index.js";

function taskWithKeys(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", { idempotencyKey: "pay-1" });
  task.dispatch("ACCEPT", { idempotencyKey: "pay-2" });
  return task;
}

test("diffTaskSnapshots: reports true when a key is consumed between snapshots", () => {
  const task = new TaskLifecycle("t-diff-key-01");
  const before = task.toJSON();
  task.dispatch("PUBLISH", { idempotencyKey: "pay-1" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.idempotencyKeysChanged, true);
});

test("diffTaskSnapshots: reports true when a key is dropped between snapshots", () => {
  const task = taskWithKeys("t-diff-key-02");
  const before = task.toJSON();
  const dropped: TaskSnapshot = { ...before };
  delete dropped.idempotencyKeys;
  const diff = diffTaskSnapshots(before, dropped);
  assert.equal(diff.idempotencyKeysChanged, true);
  // Nothing else moved: same state, same history.
  assert.equal(diff.stateChanged, undefined);
  assert.equal(diff.historyAppended, undefined);
});

test("diffTaskSnapshots: does not report when the same set is reordered", () => {
  const task = taskWithKeys("t-diff-key-03");
  const before = task.toJSON();
  const reordered: TaskSnapshot = {
    ...before,
    idempotencyKeys: ["pay-2", "pay-1"],
  };
  assert.deepEqual(diffTaskSnapshots(before, reordered), {});
});

test("diffTaskSnapshots: does not report for identical snapshots", () => {
  const task = taskWithKeys("t-diff-key-04");
  const snapshot = task.toJSON();
  assert.deepEqual(diffTaskSnapshots(snapshot, task.toJSON()), {});
});

test("diffTaskSnapshots: reports true for a legacy snapshot without keys vs one with keys", () => {
  const task = taskWithKeys("t-diff-key-05");
  const withKeys = task.toJSON();
  const legacy: TaskSnapshot = { ...withKeys };
  delete legacy.idempotencyKeys;
  assert.equal(
    diffTaskSnapshots(legacy, withKeys).idempotencyKeysChanged,
    true,
  );
});

test("diffTaskSnapshots: does not report when neither snapshot carries keys", () => {
  const task = new TaskLifecycle("t-diff-key-06");
  task.dispatch("PUBLISH");
  const snapshot = task.toJSON();
  assert.equal(snapshot.idempotencyKeys, undefined);
  assert.deepEqual(diffTaskSnapshots(snapshot, task.toJSON()), {});
});

test("diffTaskSnapshots: is orthogonal to the other five dimensions", () => {
  const task = taskWithKeys("t-diff-key-07");
  const before = task.toJSON();
  const oneKeyLess: TaskSnapshot = {
    ...before,
    idempotencyKeys: ["pay-1"],
  };
  assert.deepEqual(diffTaskSnapshots(before, oneKeyLess), {
    idempotencyKeysChanged: true,
  });
});

test("diffTaskSnapshots: reports alongside a state change when both move", () => {
  const task = new TaskLifecycle("t-diff-key-08");
  task.dispatch("PUBLISH", { idempotencyKey: "pay-1" });
  const before = task.toJSON();
  task.dispatch("ACCEPT", { idempotencyKey: "pay-2" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.idempotencyKeysChanged, true);
  assert.deepEqual(diff.stateChanged, {
    from: "OPEN",
    to: "ACCEPTED",
  });
  assert.equal(diff.historyAppended?.fromSeq, 2);
});

test("diffTaskSnapshots: treats duplicate keys in a snapshot as the same set", () => {
  const task = taskWithKeys("t-diff-key-09");
  const before = task.toJSON();
  const duplicated: TaskSnapshot = {
    ...before,
    idempotencyKeys: ["pay-1", "pay-2", "pay-1", "pay-2"],
  };
  assert.deepEqual(diffTaskSnapshots(before, duplicated), {});
});

test("diffTaskSnapshots: treats an empty key array as the same state as no field", () => {
  const task = new TaskLifecycle("t-diff-key-10");
  task.dispatch("PUBLISH");
  const before = task.toJSON();
  const empty: TaskSnapshot = { ...before, idempotencyKeys: [] };
  assert.deepEqual(diffTaskSnapshots(before, empty), {});
  assert.deepEqual(diffTaskSnapshots(empty, before), {});
});

test("diffTaskSnapshots: reports alongside history appends when both move", () => {
  const task = taskWithKeys("t-diff-key-11");
  const before = task.toJSON();
  task.dispatch("START_CAPTURE", { idempotencyKey: "pay-3" });
  const diff = diffTaskSnapshots(before, task.toJSON());
  assert.equal(diff.idempotencyKeysChanged, true);
  assert.equal(diff.historyAppended?.fromSeq, 3);
  assert.equal(diff.historyAppended?.toSeq, 3);
});
