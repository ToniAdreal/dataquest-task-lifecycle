/**
 * `DispatchOptions` unknown-field fail-closed (#1255, the paired
 * counterpart of escrow-state-machine-ts's #1254).
 *
 * `TaskLifecycle.dispatch(event, opts)` validated every known option
 * field but never scanned the keys: a typo'd `payoutref` was silently
 * dropped — losing the settlement-reconciliation anchor the caller
 * thought it had — and a typo'd `quotedamount` silently dropped the
 * quote the payout is reconciled against. The constructor got the same
 * fail-closed rule in #548 (`TASK_OPTION_FIELDS`); dispatch is the
 * same silent-config-loss class, moved from construction time to every
 * dispatch. Unknown keys now throw
 * `invalid dispatch options: unknown option "<key>"` before any field
 * is read — after the `expectedSeq` guard (which stays first of all)
 * and after the opts-must-be-object check, before the actor shape
 * validation and the idempotency dedupe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle } from "../src/index.js";

const AT = "2026-03-09T09:00:00.000Z";

/** Drive a task to APPROVED with a pinned audit clock. */
function approvedTask(id: string): TaskLifecycle {
  const task = new TaskLifecycle(id);
  task.dispatch("PUBLISH", { at: AT });
  task.dispatch("ACCEPT", { at: AT });
  task.dispatch("START_CAPTURE", { at: AT });
  task.dispatch("SUBMIT", { at: AT });
  task.dispatch("BEGIN_REVIEW", { at: AT });
  task.dispatch("APPROVE", { at: AT });
  return task;
}

describe("DispatchOptions unknown-field fail-closed", () => {
  it("accepts all eight known keys across their legal paths", () => {
    const task = new TaskLifecycle("unknown-opts-ok");
    assert.equal(
      task.dispatch("PUBLISH", {
        actor: "researcher",
        note: "publish with every key",
        at: AT,
        idempotencyKey: "publish-1",
        expectedSeq: 0,
      }),
      "OPEN",
    );
    assert.equal(task.history[0].actor, "researcher");
    assert.equal(task.history[0].note, "publish with every key");
    assert.equal(
      task.dispatch("ACCEPT", {
        quotedAmount: 149.5,
        actor: "contributor",
        at: AT,
        expectedSeq: 1,
      }),
      "ACCEPTED",
    );
    assert.equal(task.history[1].quotedAmount, 149.5);
    task.dispatch("START_CAPTURE", { at: AT });
    task.dispatch("SUBMIT", { at: AT });
    task.dispatch("BEGIN_REVIEW", { at: AT });
    task.dispatch("APPROVE", { at: AT });
    task.dispatch("REQUEST_PAYOUT", { at: AT });
    assert.equal(
      task.dispatch("PAYOUT_COMPLETE", {
        payoutRef: "xfer-2026-03-09-001",
        payoutAmount: 149.5,
        actor: "treasury",
        at: AT,
        expectedSeq: 7,
      }),
      "PAID",
    );
    assert.equal(task.history[7].payoutRef, "xfer-2026-03-09-001");
    assert.equal(task.history[7].payoutAmount, 149.5);
    assert.equal(task.history.length, 8);
  });

  it("rejects a typo'd payoutref with the exact message", () => {
    const task = approvedTask("unknown-opts-payoutref");
    assert.throws(
      () =>
        task.dispatch("REQUEST_PAYOUT", {
          payoutref: "xfer-1",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid dispatch options: unknown option "payoutref"',
    );
    assert.equal(task.state, "APPROVED");
    assert.equal(task.history.length, 6);
  });

  it("rejects a typo'd quotedamount with the exact message", () => {
    const task = new TaskLifecycle("unknown-opts-quotedamount");
    assert.throws(
      () =>
        task.dispatch("ACCEPT", {
          quotedamount: 149.5,
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          'invalid dispatch options: unknown option "quotedamount"',
    );
    // PUBLISH first: the unknown key is reported before the transition
    // check, so even the legal-first-event path reports the typo.
    const fresh = new TaskLifecycle("unknown-opts-quotedamount-2");
    assert.throws(
      () =>
        fresh.dispatch("PUBLISH", {
          quotedamount: 149.5,
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          'invalid dispatch options: unknown option "quotedamount"',
    );
    assert.equal(fresh.history.length, 0);
  });

  it("rejects a typo'd actorr with the exact message", () => {
    const task = new TaskLifecycle("unknown-opts-actorr");
    assert.throws(
      () =>
        task.dispatch("PUBLISH", {
          actorr: "researcher",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid dispatch options: unknown option "actorr"',
    );
    assert.equal(task.history.length, 0);
  });

  it("a rejected dispatch consumes no idempotency key and appends nothing, so the same key retries clean", () => {
    const task = new TaskLifecycle("unknown-opts-nokey");
    assert.throws(
      () =>
        task.dispatch("PUBLISH", {
          idempotencyKey: "publish-retry-1",
          payoutref: "xfer-1",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid dispatch options: unknown option "payoutref"',
    );
    assert.equal(task.history.length, 0);
    // The key was never consumed: the corrected retry executes.
    assert.equal(
      task.dispatch("PUBLISH", { idempotencyKey: "publish-retry-1" }),
      "OPEN",
    );
    assert.equal(task.history.length, 1);
    // And the key is consumed now: a repeat is a no-op.
    assert.equal(
      task.dispatch("PUBLISH", { idempotencyKey: "publish-retry-1" }),
      "OPEN",
    );
    assert.equal(task.history.length, 1);
  });

  it("a stale expectedSeq still reports the conflict before the unknown key", () => {
    const task = new TaskLifecycle("unknown-opts-conflict");
    task.dispatch("PUBLISH");
    assert.throws(
      () =>
        task.dispatch("ACCEPT", {
          expectedSeq: 0,
          payoutref: "xfer-1",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "dispatch conflict: expected seq 0 but task is at seq 1",
    );
    assert.equal(task.history.length, 1);
  });

  it("an unknown key is reported before transition legality", () => {
    const task = new TaskLifecycle("unknown-opts-transition");
    assert.throws(
      () =>
        task.dispatch("ACCEPT", {
          payoutref: "xfer-1",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid dispatch options: unknown option "payoutref"',
    );
    assert.equal(task.history.length, 0);
  });

  it("a duplicate key plus an unknown key still reports the unknown key, not a silent no-op", () => {
    const task = new TaskLifecycle("unknown-opts-dupkey");
    assert.equal(
      task.dispatch("PUBLISH", { idempotencyKey: "publish-dup-1" }),
      "OPEN",
    );
    assert.throws(
      () =>
        task.dispatch("PUBLISH", {
          idempotencyKey: "publish-dup-1",
          payoutref: "xfer-1",
        } as never),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'invalid dispatch options: unknown option "payoutref"',
    );
    assert.equal(task.history.length, 1);
  });

  it("non-object opts throw the must-be-object error", () => {
    const task = new TaskLifecycle("unknown-opts-shape");
    for (const bad of ["x", 42, ["actor"]]) {
      assert.throws(
        () => task.dispatch("PUBLISH", bad as never),
        (err: unknown) =>
          err instanceof Error &&
          err.message === "invalid dispatch options: opts must be an object",
      );
    }
    assert.equal(task.history.length, 0);
    assert.equal(task.dispatch("PUBLISH"), "OPEN");
  });
});
