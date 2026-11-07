import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, diffTaskSnapshots } from "../src/index.js";
import type { TaskLifecycleOptions } from "../src/index.js";

/**
 * Backlog #890 — `diffTaskSnapshots` deliberately ignores configuration.
 *
 * The `diffTaskSnapshots` JSDoc states that the configuration fields
 * (`maxResubmits`, `maxDisputes`, `maxVisitsByState`, `rolePolicy`)
 * are deliberately not reported: a diff answers "what moved since
 * the last snapshot", and configuration is not task state. Until now
 * no test backed that exclusion, so a future change that "helpfully"
 * reported a budget or policy change would drift the behaviour with
 * nothing turning red.
 *
 * The consumed idempotency-key set was originally pinned here as a
 * fifth excluded field, but backlog #963 moved it to the reported
 * side: unlike the budgets and the role policy it is not fixed
 * configuration — it grows with every keyed dispatch, so it is task
 * state. The key cases below now assert `idempotencyKeysChanged`
 * (see `test/diffTaskSnapshotsIdempotencyKeys.test.ts` for the full
 * dimension coverage); the four genuine configuration fields stay
 * pinned as excluded, including in the combined cases.
 *
 * These tests pin the existing semantics only and change no
 * implementation. Each single-field test first asserts the two
 * snapshots really do carry different values for that field, so a
 * diff of `{}` cannot pass vacuously (e.g. because `toJSON()` dropped
 * the field). Two tasks share an id in every case: `diffTaskSnapshots`
 * throws across different ids, and same-id construction is exactly how
 * a reconfigured restore presents itself.
 */

const CONFIG_A: TaskLifecycleOptions = {
  maxResubmits: 3,
  maxDisputes: 2,
  maxVisitsByState: { OPEN: 3 },
  rolePolicy: { PUBLISH: ["admin"] },
  idempotencyKeys: ["cfg-a"],
};

const CONFIG_B: TaskLifecycleOptions = {
  maxResubmits: 5,
  maxDisputes: 4,
  maxVisitsByState: { OPEN: 5 },
  rolePolicy: { PUBLISH: ["researcher"] },
  idempotencyKeys: ["cfg-b"],
};

test("diffTaskSnapshots: only maxResubmits differs -> empty diff", () => {
  const a = new TaskLifecycle("t-cfg-resubmits", { maxResubmits: 3 });
  const b = new TaskLifecycle("t-cfg-resubmits", { maxResubmits: 5 });
  assert.equal(a.toJSON().maxResubmits, 3);
  assert.equal(b.toJSON().maxResubmits, 5);
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {});
});

test("diffTaskSnapshots: only maxDisputes differs -> empty diff", () => {
  const a = new TaskLifecycle("t-cfg-disputes", { maxDisputes: 2 });
  const b = new TaskLifecycle("t-cfg-disputes", { maxDisputes: 4 });
  assert.equal(a.toJSON().maxDisputes, 2);
  assert.equal(b.toJSON().maxDisputes, 4);
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {});
});

test("diffTaskSnapshots: only maxVisitsByState differs -> empty diff", () => {
  const a = new TaskLifecycle("t-cfg-visits", {
    maxVisitsByState: { OPEN: 3 },
  });
  const b = new TaskLifecycle("t-cfg-visits", {
    maxVisitsByState: { OPEN: 5 },
  });
  assert.deepEqual(a.toJSON().maxVisitsByState, { OPEN: 3 });
  assert.deepEqual(b.toJSON().maxVisitsByState, { OPEN: 5 });
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {});
});

test("diffTaskSnapshots: only rolePolicy differs -> empty diff", () => {
  const a = new TaskLifecycle("t-cfg-policy", {
    rolePolicy: { PUBLISH: ["researcher"] },
  });
  const b = new TaskLifecycle("t-cfg-policy", {
    rolePolicy: { PUBLISH: ["admin"] },
  });
  assert.deepEqual(a.toJSON().rolePolicy, { PUBLISH: ["researcher"] });
  assert.deepEqual(b.toJSON().rolePolicy, { PUBLISH: ["admin"] });
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {});
});

test("diffTaskSnapshots: only consumed idempotencyKeys differ -> only idempotencyKeysChanged (backlog #963)", () => {
  const a = new TaskLifecycle("t-cfg-keys", { idempotencyKeys: ["k-a"] });
  const b = new TaskLifecycle("t-cfg-keys", { idempotencyKeys: ["k-b"] });
  assert.deepEqual(a.toJSON().idempotencyKeys, ["k-a"]);
  assert.deepEqual(b.toJSON().idempotencyKeys, ["k-b"]);
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {
    idempotencyKeysChanged: true,
  });
});

test("diffTaskSnapshots: all five configuration fields differ at once -> only idempotencyKeysChanged", () => {
  const a = new TaskLifecycle("t-cfg-all", CONFIG_A);
  const b = new TaskLifecycle("t-cfg-all", CONFIG_B);
  assert.equal(a.toJSON().maxResubmits, 3);
  assert.equal(b.toJSON().maxResubmits, 5);
  assert.deepEqual(a.toJSON().rolePolicy, { PUBLISH: ["admin"] });
  assert.deepEqual(b.toJSON().rolePolicy, { PUBLISH: ["researcher"] });
  assert.deepEqual(a.toJSON().idempotencyKeys, ["cfg-a"]);
  assert.deepEqual(b.toJSON().idempotencyKeys, ["cfg-b"]);
  assert.deepEqual(diffTaskSnapshots(a.toJSON(), b.toJSON()), {
    idempotencyKeysChanged: true,
  });
});

test("diffTaskSnapshots: config change plus a dispatch reports state, history, and the key change", () => {
  const before = new TaskLifecycle("t-cfg-plus-state", CONFIG_A).toJSON();
  const afterTask = new TaskLifecycle("t-cfg-plus-state", CONFIG_B);
  afterTask.dispatch("PUBLISH", { actor: "researcher" });
  const diff = diffTaskSnapshots(before, afterTask.toJSON());
  assert.deepEqual(Object.keys(diff).sort(), [
    "historyAppended",
    "idempotencyKeysChanged",
    "stateChanged",
  ]);
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "OPEN" });
  assert.equal(diff.historyAppended?.entries.length, 1);
  assert.equal(diff.historyAppended?.entries[0].event, "PUBLISH");
  assert.equal(diff.idempotencyKeysChanged, true);
  assert.equal(diff.payoutChanged, undefined);
  assert.equal(diff.slaChanged, undefined);
});

test("diffTaskSnapshots: config change plus dispatch plus SLA deadline reports state, history, SLA, and the key change", () => {
  const before = new TaskLifecycle("t-cfg-plus-sla", CONFIG_A).toJSON();
  const afterTask = new TaskLifecycle("t-cfg-plus-sla", CONFIG_B);
  afterTask.dispatch("PUBLISH", { actor: "researcher" });
  afterTask.setSlaDeadline("2026-12-01T00:00:00.000Z", "OPEN");
  const diff = diffTaskSnapshots(before, afterTask.toJSON());
  assert.deepEqual(Object.keys(diff).sort(), [
    "historyAppended",
    "idempotencyKeysChanged",
    "slaChanged",
    "stateChanged",
  ]);
  assert.deepEqual(diff.stateChanged, { from: "DRAFT", to: "OPEN" });
  assert.deepEqual(diff.slaChanged, {
    from: {},
    to: { OPEN: "2026-12-01T00:00:00.000Z" },
  });
  assert.equal(diff.idempotencyKeysChanged, true);
  assert.equal(diff.payoutChanged, undefined);
});
