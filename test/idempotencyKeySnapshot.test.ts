import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * Backlog #130 — idempotency-key set snapshot persistence.
 *
 * Previously `_idempotencyKeys` was a purely in-memory Set and
 * `toJSON()` deliberately omitted it, so any restart through a snapshot
 * (`fromJSON`/`fromHistory`) silently lost the exactly-once guarantee
 * the keys exist for (#82). Now:
 *  - `TaskSnapshot.idempotencyKeys` carries the consumed keys, written
 *    only when the set is non-empty (legacy snapshot shape unchanged)
 *  - `fromJSON()` restores them through strict validation
 *    (non-array / non-string / empty-string -> `invalid snapshot`),
 *    duplicates deduped
 *  - `fromHistory(id, history, { idempotencyKeys })` re-attaches them,
 *    like `requirePayoutRef` (configuration, not audit data)
 *  - failed dispatches never consume a key, so they never reach the
 *    snapshot either
 */

test("consumed key survives toJSON/fromJSON: retry is a no-op with no listener notification", () => {
  const t = new TaskLifecycle("snap-1");
  t.dispatch("PUBLISH", { idempotencyKey: "pay-1" });
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  const seen: string[] = [];
  restored.subscribe((event) => {
    seen.push(event);
  });
  const returned = restored.dispatch("PUBLISH", { idempotencyKey: "pay-1" });
  assert.equal(returned, "OPEN");
  assert.equal(restored.history.length, 1);
  assert.equal(restored.state, "OPEN");
  assert.deepEqual(seen, []);
});

test("multiple consumed keys all survive, in consumption order", () => {
  const t = new TaskLifecycle("snap-2");
  t.dispatch("PUBLISH", { idempotencyKey: "k-a" });
  t.dispatch("ACCEPT", { idempotencyKey: "k-b" });
  assert.deepEqual(t.toJSON().idempotencyKeys, ["k-a", "k-b"]);
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  // Both keys dedupe even on different (now legal) events.
  assert.equal(restored.dispatch("START_CAPTURE", { idempotencyKey: "k-a" }), "ACCEPTED");
  assert.equal(restored.dispatch("START_CAPTURE", { idempotencyKey: "k-b" }), "ACCEPTED");
  assert.equal(restored.history.length, 2);
  // A fresh key still executes.
  restored.dispatch("START_CAPTURE", { idempotencyKey: "k-c" });
  assert.equal(restored.state, "CAPTURING");
  assert.deepEqual(restored.toJSON().idempotencyKeys, ["k-a", "k-b", "k-c"]);
});

test("empty key set is not written: legacy snapshot shape is unchanged", () => {
  const t = new TaskLifecycle("snap-3");
  t.dispatch("PUBLISH"); // no key
  const snap = t.toJSON();
  assert.equal("idempotencyKeys" in snap, false);
  assert.deepEqual(Object.keys(snap), ["id", "state", "history", "slaDeadlines"]);
});

test("JSON.stringify(task) carries the keys through the wire round-trip", () => {
  const t = new TaskLifecycle("snap-4");
  t.dispatch("PUBLISH", { idempotencyKey: "wire-1" });
  const wire = JSON.parse(JSON.stringify(t)) as unknown;
  const restored = TaskLifecycle.fromJSON(wire);
  assert.equal(restored.dispatch("ACCEPT", { idempotencyKey: "wire-1" }), "OPEN");
  assert.equal(restored.history.length, 1);
});

test("snapshot with a non-array idempotencyKeys is rejected", () => {
  const t = new TaskLifecycle("snap-5");
  t.dispatch("PUBLISH", { idempotencyKey: "x" });
  for (const bad of ["x", 42, null, { 0: "x" }] as unknown[]) {
    const snap = { ...t.toJSON(), idempotencyKeys: bad };
    assert.throws(
      () => TaskLifecycle.fromJSON(snap),
      /invalid snapshot: idempotencyKeys must be an array/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test("snapshot with empty-string or non-string key entries is rejected", () => {
  const t = new TaskLifecycle("snap-6");
  t.dispatch("PUBLISH", { idempotencyKey: "x" });
  for (const bad of [[""], ["ok", ""], [123], [null], [{}]] as unknown[]) {
    const snap = { ...t.toJSON(), idempotencyKeys: bad };
    assert.throws(
      () => TaskLifecycle.fromJSON(snap),
      /invalid snapshot: idempotencyKeys entries must be non-empty strings/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test("duplicate keys in a snapshot are deduped, not rejected", () => {
  const t = new TaskLifecycle("snap-7");
  t.dispatch("PUBLISH", { idempotencyKey: "dup" });
  const snap = { ...t.toJSON(), idempotencyKeys: ["dup", "dup", "other", "dup"] };
  const restored = TaskLifecycle.fromJSON(snap);
  assert.deepEqual(restored.toJSON().idempotencyKeys, ["dup", "other"]);
  assert.equal(restored.dispatch("ACCEPT", { idempotencyKey: "other" }), "OPEN");
  assert.equal(restored.history.length, 1);
});

test("fromHistory re-attaches keys via options", () => {
  const t = new TaskLifecycle("snap-8");
  t.dispatch("PUBLISH", { idempotencyKey: "hist-1" });
  const restored = TaskLifecycle.fromHistory(t.id, t.history, {
    idempotencyKeys: ["hist-1"],
  });
  assert.equal(restored.dispatch("ACCEPT", { idempotencyKey: "hist-1" }), "OPEN");
  assert.equal(restored.history.length, 1);
  // Without the option, the audit log alone cannot restore the set.
  const bare = TaskLifecycle.fromHistory(t.id, t.history);
  bare.dispatch("ACCEPT", { idempotencyKey: "hist-1" });
  assert.equal(bare.history.length, 2);
});

test("fromHistory rejects invalid idempotencyKeys options", () => {
  const t = new TaskLifecycle("snap-9");
  t.dispatch("PUBLISH", { idempotencyKey: "hist-1" });
  assert.throws(
    () => TaskLifecycle.fromHistory(t.id, t.history, { idempotencyKeys: [""] }),
    /invalid option: idempotencyKeys entries must be non-empty strings/,
  );
  assert.throws(
    () =>
      TaskLifecycle.fromHistory(t.id, t.history, {
        idempotencyKeys: "hist-1" as unknown as string[],
      }),
    /invalid option: idempotencyKeys must be an array/,
  );
});

test("a failed dispatch's key never reaches the snapshot", () => {
  const t = new TaskLifecycle("snap-10");
  assert.throws(() => t.dispatch("ACCEPT", { idempotencyKey: "fail-1" }), /invalid transition/);
  assert.equal("idempotencyKeys" in t.toJSON(), false);
  t.dispatch("PUBLISH", { idempotencyKey: "ok-1" });
  assert.throws(() =>
    t.dispatch("PAYOUT_COMPLETE", { idempotencyKey: "fail-2" }),
  );
  assert.deepEqual(t.toJSON().idempotencyKeys, ["ok-1"]);
});

test("constructor can seed keys, and validates them", () => {
  const t = new TaskLifecycle("snap-11", { idempotencyKeys: ["seed-1", "seed-1"] });
  assert.deepEqual(t.toJSON().idempotencyKeys, ["seed-1"]);
  assert.equal(t.dispatch("PUBLISH", { idempotencyKey: "seed-1" }), "DRAFT");
  assert.equal(t.history.length, 0);
  assert.throws(
    () => new TaskLifecycle("snap-12", { idempotencyKeys: [42 as unknown as string] }),
    /invalid option: idempotencyKeys entries must be non-empty strings/,
  );
});

test("the snapshot's key list is detached from the live task", () => {
  const t = new TaskLifecycle("snap-13");
  t.dispatch("PUBLISH", { idempotencyKey: "live-1" });
  const snap = t.toJSON();
  snap.idempotencyKeys!.push("injected");
  // Mutating the exported snapshot must not seed the live task.
  t.dispatch("ACCEPT", { idempotencyKey: "injected" });
  assert.equal(t.history.length, 2);
  assert.equal(t.state, "ACCEPTED");
});
