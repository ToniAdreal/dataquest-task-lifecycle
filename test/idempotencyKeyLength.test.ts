import test from "node:test";
import assert from "node:assert/strict";
import { MAX_IDEMPOTENCY_KEY_LENGTH, TaskLifecycle } from "../src/index.js";

/**
 * Idempotency-key length cap (backlog #1065, mirrors escrow #1064):
 * `MAX_IDEMPOTENCY_KEY_LENGTH = 256`, enforced identically at
 * dispatch, at the constructor seed, at snapshot parse, and at
 * `fromHistory` (which funnels through the constructor).
 *
 * Rules under test:
 *  - an overlong key is rejected, never truncated, at all four paths
 *  - a rejected key consumes nothing and leaves no residue
 *  - a key exactly at the cap passes verbatim and still dedupes
 *  - short keys behave exactly as before
 */

const OVERLONG = "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
const AT_CAP = "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH);

test("MAX_IDEMPOTENCY_KEY_LENGTH is 256", () => {
  assert.equal(MAX_IDEMPOTENCY_KEY_LENGTH, 256);
});

test("dispatch rejects an overlong idempotencyKey with zero residue", () => {
  const t = new TaskLifecycle("idem-len-1");
  assert.throws(
    () => t.dispatch("PUBLISH", { idempotencyKey: OVERLONG }),
    /invalid dispatch options: idempotencyKey must be at most 256 characters, got 257/,
  );
  assert.equal(t.history.length, 0);
  assert.equal(t.state, "DRAFT");
  assert.equal("idempotencyKeys" in t.toJSON(), false);
});

test("a rejected overlong key is not consumed: retry still throws, short keys still work", () => {
  const t = new TaskLifecycle("idem-len-2");
  assert.throws(
    () => t.dispatch("PUBLISH", { idempotencyKey: OVERLONG }),
    /idempotencyKey must be at most 256 characters/,
  );
  // The same overlong key again must still throw the length error,
  // not silently no-op as a "known" key.
  assert.throws(
    () => t.dispatch("PUBLISH", { idempotencyKey: OVERLONG }),
    /idempotencyKey must be at most 256 characters/,
  );
  t.dispatch("PUBLISH", { idempotencyKey: "short-key" });
  assert.equal(t.history.length, 1);
  assert.equal(t.state, "OPEN");
});

test("constructor seed rejects an overlong idempotencyKey", () => {
  assert.throws(
    () => new TaskLifecycle("idem-len-3", { idempotencyKeys: [OVERLONG] }),
    /invalid option: idempotencyKeys entries must be at most 256 characters, got 257/,
  );
});

test("snapshot parse rejects an overlong idempotencyKey", () => {
  const t = new TaskLifecycle("idem-len-4");
  t.dispatch("PUBLISH", { idempotencyKey: "seed-key" });
  const snapshot = JSON.parse(JSON.stringify(t.toJSON())) as Record<
    string,
    unknown
  >;
  snapshot.idempotencyKeys = [OVERLONG];
  assert.throws(
    () => TaskLifecycle.fromJSON(snapshot),
    /invalid snapshot: idempotencyKeys entries must be at most 256 characters, got 257/,
  );
});

test("fromHistory rejects an overlong idempotencyKeys seed", () => {
  const t = new TaskLifecycle("idem-len-5");
  t.dispatch("PUBLISH");
  assert.throws(
    () =>
      TaskLifecycle.fromHistory("idem-len-5", t.history, {
        idempotencyKeys: [OVERLONG],
      }),
    /invalid option: idempotencyKeys entries must be at most 256 characters, got 257/,
  );
});

test("a key exactly at the cap dispatches verbatim and still dedupes", () => {
  const t = new TaskLifecycle("idem-len-6");
  t.dispatch("PUBLISH", { idempotencyKey: AT_CAP });
  assert.equal(t.history.length, 1);
  const returned = t.dispatch("PUBLISH", { idempotencyKey: AT_CAP });
  assert.equal(returned, "OPEN");
  assert.equal(t.history.length, 1);
  assert.deepEqual(t.toJSON().idempotencyKeys, [AT_CAP]);
});

test("short keys are unaffected by the cap", () => {
  const t = new TaskLifecycle("idem-len-7");
  t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  assert.equal(t.history.length, 1);
  assert.equal(t.state, "OPEN");
});

test("snapshot round-trip carries an at-cap key and the replay stays a no-op", () => {
  const t = new TaskLifecycle("idem-len-8");
  t.dispatch("PUBLISH", { idempotencyKey: AT_CAP });
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  assert.deepEqual(restored.toJSON().idempotencyKeys, [AT_CAP]);
  const returned = restored.dispatch("PUBLISH", { idempotencyKey: AT_CAP });
  assert.equal(returned, "OPEN");
  assert.equal(restored.history.length, 1);
});

test("fromHistory with an at-cap seed restores the no-op", () => {
  const t = new TaskLifecycle("idem-len-9");
  t.dispatch("PUBLISH");
  const restored = TaskLifecycle.fromHistory("idem-len-9", t.history, {
    idempotencyKeys: [AT_CAP],
  });
  const returned = restored.dispatch("PUBLISH", { idempotencyKey: AT_CAP });
  assert.equal(returned, "OPEN");
  assert.equal(restored.history.length, 1);
});
