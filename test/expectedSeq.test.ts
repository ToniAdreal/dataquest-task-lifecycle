import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

/**
 * `dispatch(event, { expectedSeq })` — optimistic-concurrency guard,
 * the paired counterpart of escrow-state-machine-ts's guard (backlog
 * #153) with identical semantics.
 *
 * Rules under test:
 *  - `expectedSeq` asserts the current history length (= last entry's
 *    seq; 0 for an empty history) and is checked before every other
 *    dispatch validation — option shape, idempotency dedupe, transition
 *    legality, RBAC, budgets — and before any mutation
 *  - a match advances normally; a mismatch (stale or ahead) throws
 *    `dispatch conflict: expected seq <n> but task is at seq <m>` and
 *    changes nothing: state, history, the consumed idempotency-key
 *    set, and listener notifications are all untouched
 *  - a non-integer / negative / non-number value throws
 *    `invalid dispatch options: …` up front
 *  - after a conflict, re-reading the task and retrying with the fresh
 *    seq succeeds (including with the idempotency key the conflicted
 *    attempt carried — a conflict consumes nothing)
 *  - omitting `expectedSeq` preserves the exact pre-guard behavior
 */

test("matching expectedSeq advances normally, step by step", () => {
  const t = new TaskLifecycle("seq-1");
  assert.equal(t.dispatch("PUBLISH", { expectedSeq: 0 }), "OPEN");
  assert.equal(t.dispatch("ACCEPT", { expectedSeq: 1 }), "ACCEPTED");
  assert.equal(t.dispatch("START_CAPTURE", { expectedSeq: 2 }), "CAPTURING");
  assert.equal(t.history.length, 3);
  assert.equal(t.history[2].seq, 3);
});

test("expectedSeq 0 is the guard for an empty history", () => {
  const t = new TaskLifecycle("seq-2");
  assert.equal(t.history.length, 0);
  assert.equal(t.dispatch("PUBLISH", { expectedSeq: 0 }), "OPEN");
  // …and 0 is stale immediately afterwards.
  assert.throws(
    () => t.dispatch("ACCEPT", { expectedSeq: 0 }),
    /dispatch conflict: expected seq 0 but task is at seq 1/,
  );
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
});

test("stale expectedSeq throws conflict and leaves state/history/listeners untouched", () => {
  const t = new TaskLifecycle("seq-3");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  let notified = 0;
  t.subscribe(() => {
    notified++;
  });
  assert.throws(
    () => t.dispatch("START_CAPTURE", { expectedSeq: 1 }),
    /dispatch conflict: expected seq 1 but task is at seq 2/,
  );
  assert.equal(t.state, "ACCEPTED");
  assert.equal(t.history.length, 2);
  assert.equal(notified, 0);
});

test("an expectedSeq ahead of the task also conflicts", () => {
  const t = new TaskLifecycle("seq-4");
  t.dispatch("PUBLISH");
  assert.throws(
    () => t.dispatch("ACCEPT", { expectedSeq: 5 }),
    /dispatch conflict: expected seq 5 but task is at seq 1/,
  );
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
});

test("a conflict consumes no idempotency key: the same key retries successfully", () => {
  const t = new TaskLifecycle("seq-5");
  t.dispatch("PUBLISH");
  // Stale guard + a fresh key: the conflict must not consume the key.
  assert.throws(
    () =>
      t.dispatch("ACCEPT", { expectedSeq: 0, idempotencyKey: "accept-1" }),
    /dispatch conflict: expected seq 0 but task is at seq 1/,
  );
  assert.deepEqual(t.toJSON().idempotencyKeys, undefined);
  // Retry with the fresh seq and the SAME key executes for real…
  assert.equal(
    t.dispatch("ACCEPT", { expectedSeq: 1, idempotencyKey: "accept-1" }),
    "ACCEPTED",
  );
  assert.equal(t.history.length, 2);
  assert.deepEqual(t.toJSON().idempotencyKeys, ["accept-1"]);
  // …and only now is the key consumed (a bare retry is a no-op).
  assert.equal(t.dispatch("ACCEPT", { idempotencyKey: "accept-1" }), "ACCEPTED");
  assert.equal(t.history.length, 2);
});

test("invalid expectedSeq values throw up front and append nothing", () => {
  const t = new TaskLifecycle("seq-6");
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, "1", null, {}] as unknown[]) {
    assert.throws(
      () => t.dispatch("PUBLISH", { expectedSeq: bad as number }),
      /invalid dispatch options: expectedSeq must be a non-negative integer/,
      `should reject ${String(bad)}`,
    );
  }
  assert.equal(t.state, "DRAFT");
  assert.equal(t.history.length, 0);
});

test("after a conflict, retrying with the fresh seq succeeds", () => {
  const t = new TaskLifecycle("seq-7");
  t.dispatch("PUBLISH", { expectedSeq: 0 });
  // A second writer still holding the seq-0 snapshot conflicts…
  assert.throws(
    () => t.dispatch("ACCEPT", { expectedSeq: 0 }),
    /dispatch conflict: expected seq 0 but task is at seq 1/,
  );
  // …re-reads (seq is now 1) and retries successfully.
  assert.equal(t.dispatch("ACCEPT", { expectedSeq: 1 }), "ACCEPTED");
  assert.equal(t.history.length, 2);
});

test("the guard runs first: conflict beats option-shape and transition errors", () => {
  const t = new TaskLifecycle("seq-8");
  t.dispatch("PUBLISH");
  // Stale seq + invalid actor + illegal transition: the conflict wins,
  // because the caller's premise (the seq) is checked before the call
  // itself is even validated.
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        expectedSeq: 0,
        actor: 123 as unknown as string,
      }),
    /dispatch conflict: expected seq 0 but task is at seq 1/,
  );
  // An invalid expectedSeq value likewise beats an illegal transition.
  assert.throws(
    () => t.dispatch("PAYOUT_COMPLETE", { expectedSeq: -2 }),
    /invalid dispatch options: expectedSeq must be a non-negative integer/,
  );
  assert.equal(t.state, "OPEN");
  assert.equal(t.history.length, 1);
});

test("omitting expectedSeq preserves the pre-guard behavior", () => {
  const t = new TaskLifecycle("seq-9");
  t.dispatch("PUBLISH");
  t.dispatch("ACCEPT");
  assert.throws(() => t.dispatch("PUBLISH"), /invalid transition/);
  assert.equal(t.dispatch("START_CAPTURE"), "CAPTURING");
  assert.equal(t.history.length, 3);
});
