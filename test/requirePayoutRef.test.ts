import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, type TaskLifecycleOptions } from "../src/index.js";

/**
 * `requirePayoutRef` — opt-in up-front enforcement of the payout reference
 * on PAYOUT_COMPLETE. The default stays advisory-only (the library cannot
 * verify whether an external payment really happened); flipping the
 * switch makes "no ref" a dispatch-time error instead of a
 * reconciliation-time finding.
 *
 * Rules under test:
 *  - enabled: PAYOUT_COMPLETE without payoutRef throws
 *    `payout reference required: …` and leaves no history residue
 *  - enabled: PAYOUT_COMPLETE with a payoutRef passes
 *  - disabled (default): PAYOUT_COMPLETE without payoutRef stays legal
 *  - only PAYOUT_COMPLETE is gated; other events are unaffected
 *  - non-boolean option values throw `invalid option` at construction
 *  - a rejected dispatch consumes no idempotency key and leaves no seq gap
 *  - the switch is task configuration, not audit data: it is never
 *    written into the toJSON() snapshot (unlike maxDisputes/maxResubmits)
 *  - fromJSON() does not restore the switch (falls back to advisory);
 *    fromHistory(id, history, { requirePayoutRef: true }) re-attaches it
 */

/** Drive a task from DRAFT to APPROVED, with optional ctor options. */
function toApproved(id: string, opts?: TaskLifecycleOptions): TaskLifecycle {
  const t = new TaskLifecycle(id, opts);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

test("enabled: PAYOUT_COMPLETE without payoutRef throws and leaves no trace", () => {
  const t = toApproved("rpr-1", { requirePayoutRef: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /payout reference required/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("enabled: PAYOUT_COMPLETE with a payoutRef passes", () => {
  const t = toApproved("rpr-2", { requirePayoutRef: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-enforced",
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history[t.history.length - 1].payoutRef, "xfer-enforced");
});

test("disabled by default: PAYOUT_COMPLETE without payoutRef stays legal", () => {
  const t = toApproved("rpr-3");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
});

test("non-boolean requirePayoutRef values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new TaskLifecycle("rpr-4", { requirePayoutRef: bad as never }),
      /invalid option: requirePayoutRef must be a boolean/,
    );
  }
});

test("enforcement gates only PAYOUT_COMPLETE", () => {
  const t = toApproved("rpr-5", { requirePayoutRef: true });
  // REQUEST_PAYOUT without a ref is still fine — the gate is on
  // PAYOUT_COMPLETE only.
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  t.dispatch("PAYOUT_COMPLETE", { payoutRef: "xfer-5" });
  assert.equal(t.state, "PAID");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const t = toApproved("rpr-6", { requirePayoutRef: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = t.history.length;
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        idempotencyKey: "k-pay-1",
      }),
    /payout reference required/,
  );
  assert.equal(t.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-6",
    idempotencyKey: "k-pay-1",
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history.length, before + 1);
  assert.equal(t.history[t.history.length - 1].seq, before + 1);
});

test("the switch is not written into the toJSON() snapshot", () => {
  const t = toApproved("rpr-7", { requirePayoutRef: true });
  const snapshot = t.toJSON();
  assert.equal("requirePayoutRef" in snapshot, false);
  // ...but the budget-style finite switches keep their own convention.
  assert.equal("maxDisputes" in snapshot, false);
});

test("fromJSON() does not restore the switch: advisory again after restore", () => {
  const t = toApproved("rpr-8", { requirePayoutRef: true });
  const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(t)));
  restored.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  restored.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(restored.state, "PAID");
});

test("fromHistory() re-attaches the switch via options", () => {
  const t = toApproved("rpr-9");
  const history = JSON.parse(JSON.stringify(t.history));
  const rehydrated = TaskLifecycle.fromHistory("rpr-9", history, {
    requirePayoutRef: true,
  });
  rehydrated.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.throws(
    () => rehydrated.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /payout reference required/,
  );
  // ...and without the option the rehydrated task stays advisory.
  const relaxed = TaskLifecycle.fromHistory("rpr-9", history);
  relaxed.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  relaxed.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(relaxed.state, "PAID");
});
