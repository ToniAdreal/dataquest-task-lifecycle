import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * `dispatch(event, { idempotencyKey })` — retry-safe dispatch, mirroring
 * escrow-state-machine-ts's idempotency keys for payment-flavored flows.
 *
 * Rules under test:
 *  - a repeated key is a full no-op: returns the current state, appends
 *    nothing, notifies no listeners, does not validate the transition
 *    (retry-after-progress is safe)
 *  - keys are global to the task, not per-event: reusing the key for a
 *    different event still dedupes
 *  - distinct keys (or no key) append normally
 *  - empty / non-string keys throw `invalid dispatch options` up front
 *  - a failed dispatch consumes nothing: fixing the call and retrying
 *    with the same key still executes
 *  - listeners are not notified by duplicate-key no-ops
 *  - the key set is in-memory only: toJSON()/fromJSON() do not carry it,
 *    so a retried key re-executes after rehydration (documented limit)
 */

test("same idempotencyKey dispatched twice leaves a single history entry", () => {
  const t = new TaskLifecycle("idem-1");
  t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  assert.equal(t.history.length, 1);
  assert.equal(t.state, "OPEN");
  assert.equal(t.history[0].seq, 1);
  assert.equal(t.history[0].event, "PUBLISH");
});

test("duplicate key returns the current state without validating the transition", () => {
  const t = new TaskLifecycle("idem-2");
  t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  t.dispatch("ACCEPT", { actor: "c" }); // move on: now ACCEPTED
  // Same key again, with a stale (now illegal) event: must NOT throw
  // `invalid transition`, must NOT append, returns the CURRENT state.
  const returned = t.dispatch("PUBLISH", { idempotencyKey: "req-1" });
  assert.equal(returned, "ACCEPTED");
  assert.equal(t.history.length, 2);
});

test("different keys append normally; omitting the key preserves old behavior", () => {
  const t = new TaskLifecycle("idem-3");
  t.dispatch("PUBLISH", { idempotencyKey: "a" });
  t.dispatch("ACCEPT", { idempotencyKey: "b" });
  t.dispatch("START_CAPTURE"); // no key at all
  assert.equal(t.history.length, 3);
  assert.equal(t.state, "CAPTURING");
});

test("key is global to the task, not per-event", () => {
  const t = new TaskLifecycle("idem-4");
  t.dispatch("PUBLISH", { idempotencyKey: "shared" });
  // Same key on a different (now legal) event still dedupes.
  const returned = t.dispatch("ACCEPT", { idempotencyKey: "shared" });
  assert.equal(returned, "OPEN");
  assert.equal(t.history.length, 1);
});

test("empty and non-string idempotencyKey throw up front", () => {
  const t = new TaskLifecycle("idem-5");
  for (const bad of ["", 123, null, {}, []] as unknown[]) {
    assert.throws(
      () => t.dispatch("PUBLISH", { idempotencyKey: bad as string }),
      /invalid dispatch options: idempotencyKey must be a non-empty string/,
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(t.history.length, 0);
});

test("a failed dispatch does not consume the key: corrected retry works", () => {
  const t = new TaskLifecycle("idem-6");
  // First attempt: bad actor option fails up front (before the key is seen).
  assert.throws(
    () => t.dispatch("PUBLISH", { actor: 123 as unknown as string, idempotencyKey: "k" }),
    /invalid dispatch options: actor must be a string/,
  );
  assert.equal(t.history.length, 0);
  // Same key with fixed options executes normally.
  t.dispatch("PUBLISH", { actor: "researcher", idempotencyKey: "k" });
  assert.equal(t.history.length, 1);
  assert.equal(t.state, "OPEN");
});

test("a failed transition does not consume the key either", () => {
  const t = new TaskLifecycle("idem-7");
  // "ACCEPT" from DRAFT is an invalid transition.
  assert.throws(
    () => t.dispatch("ACCEPT", { idempotencyKey: "k2" }),
    /invalid transition/,
  );
  assert.equal(t.history.length, 0);
  // Correct event with the same key works.
  t.dispatch("PUBLISH", { idempotencyKey: "k2" });
  assert.equal(t.history.length, 1);
  assert.equal(t.state, "OPEN");
});

test("duplicate-key no-ops do not notify listeners", () => {
  const t = new TaskLifecycle("idem-8");
  const seen: string[] = [];
  t.subscribe((event) => {
    seen.push(event);
  });
  t.dispatch("PUBLISH", { idempotencyKey: "n" });
  t.dispatch("PUBLISH", { idempotencyKey: "n" });
  assert.deepEqual(seen, ["PUBLISH"]);
  assert.equal(t.listenerCount, 1);
});

test("key set is in-memory only: not carried by toJSON()/fromJSON()", () => {
  const t = new TaskLifecycle("idem-9");
  t.dispatch("PUBLISH", { idempotencyKey: "once" });
  const restored = TaskLifecycle.fromJSON(t.toJSON());
  // Documented honest limit: rehydrated tasks restart with an empty set,
  // so a retry with the same key re-executes (here: the next legal event)
  // instead of silently deduping.
  restored.dispatch("ACCEPT", { idempotencyKey: "once" });
  assert.equal(restored.history.length, 2);
  assert.deepEqual(restored.history.map((e) => e.event), [
    "PUBLISH",
    "ACCEPT",
  ]);
  assert.equal(restored.state, "ACCEPTED");
});

test("seq has no gaps after duplicates and failures", () => {
  const t = new TaskLifecycle("idem-10");
  t.dispatch("PUBLISH", { idempotencyKey: "g1" });
  t.dispatch("PUBLISH", { idempotencyKey: "g1" }); // no-op
  assert.throws(() =>
    t.dispatch("SUBMIT", { idempotencyKey: "g2" }),
  ); // invalid transition, key not consumed
  t.dispatch("ACCEPT", { idempotencyKey: "g2" }); // same key works after failure
  t.dispatch("START_CAPTURE", { idempotencyKey: "g3" });
  assert.deepEqual(
    t.history.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(t.state, "CAPTURING");
});
