import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, type TaskLifecycleOptions } from "../src/index.js";

/**
 * `requirePayoutAmount` — opt-in up-front enforcement of the settled
 * payout amount on PAYOUT_COMPLETE, mirroring `requirePayoutRef` (the
 * reference says *which transfer*, the amount says *how much*). The
 * default stays advisory-only (the library cannot verify whether an
 * external payment really happened); flipping the switch makes "no
 * amount" a dispatch-time error instead of a reconciliation-time
 * finding.
 *
 * Rules under test:
 *  - enabled: PAYOUT_COMPLETE without payoutAmount throws
 *    `payout amount required: …` and leaves no history residue
 *  - enabled: PAYOUT_COMPLETE with a payoutAmount passes, and 0 is a
 *    legal amount (a zero-value settlement is still a settlement)
 *  - enabled: an invalid amount (NaN / negative / sub-cent) still
 *    throws the dispatch shape error, not the gate error — the gate
 *    only checks presence, the shape check runs first
 *  - disabled (default): PAYOUT_COMPLETE without payoutAmount stays legal
 *  - only PAYOUT_COMPLETE is gated; other events are unaffected
 *  - non-boolean option values throw `invalid option` at construction
 *  - a rejected dispatch consumes no idempotency key and leaves no seq gap
 *  - the switch is task configuration, not audit data: it is never
 *    written into the toJSON() snapshot (unlike maxDisputes/maxResubmits)
 *  - fromJSON() does not restore the switch (falls back to advisory);
 *    fromHistory(id, history, { requirePayoutAmount: true }) re-attaches it
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

test("enabled: PAYOUT_COMPLETE without payoutAmount throws and leaves no trace", () => {
  const t = toApproved("rpa-1", { requirePayoutAmount: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = t.history.length;
  assert.throws(
    () => t.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /payout amount required/,
  );
  assert.equal(t.history.length, before);
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("enabled: PAYOUT_COMPLETE with a payoutAmount passes", () => {
  const t = toApproved("rpa-2", { requirePayoutAmount: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 42.5,
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history[t.history.length - 1].payoutAmount, 42.5);
});

test("enabled: payoutAmount 0 is a legal amount", () => {
  const t = toApproved("rpa-3", { requirePayoutAmount: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 0 });
  assert.equal(t.state, "PAID");
  assert.equal(t.history[t.history.length - 1].payoutAmount, 0);
});

test("disabled by default: PAYOUT_COMPLETE without payoutAmount stays legal", () => {
  const t = toApproved("rpa-4");
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(t.state, "PAID");
});

test("non-boolean requirePayoutAmount values throw at construction", () => {
  for (const bad of ["yes", 1, 0, null, {}, []] as const) {
    assert.throws(
      () => new TaskLifecycle("rpa-5", { requirePayoutAmount: bad as never }),
      /invalid option: requirePayoutAmount must be a boolean/,
    );
  }
});

test("enforcement gates only PAYOUT_COMPLETE", () => {
  const t = toApproved("rpa-6", { requirePayoutAmount: true });
  // REQUEST_PAYOUT without an amount is still fine — the gate is on
  // PAYOUT_COMPLETE only.
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.equal(t.state, "PAYOUT_PENDING");
  t.dispatch("PAYOUT_COMPLETE", { payoutAmount: 10 });
  assert.equal(t.state, "PAID");
});

test("enabled: invalid amounts still throw the shape error, not the gate error", () => {
  const t = toApproved("rpa-7", { requirePayoutAmount: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = t.history.length;
  for (const bad of [Number.NaN, -1, Infinity, 0.001] as const) {
    assert.throws(
      () => t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: bad }),
      /invalid dispatch options: payoutAmount must be/,
    );
  }
  assert.equal(t.history.length, before);
  assert.equal(t.state, "PAYOUT_PENDING");
});

test("rejected dispatch consumes no idempotency key and leaves no seq gap", () => {
  const t = toApproved("rpa-8", { requirePayoutAmount: true });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  const before = t.history.length;
  assert.throws(
    () =>
      t.dispatch("PAYOUT_COMPLETE", {
        actor: "system",
        idempotencyKey: "k-pay-amt-1",
      }),
    /payout amount required/,
  );
  assert.equal(t.history.length, before);
  // The failed dispatch consumed nothing: the corrected retry with the
  // same key still executes.
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 10,
    idempotencyKey: "k-pay-amt-1",
  });
  assert.equal(t.state, "PAID");
  assert.equal(t.history.length, before + 1);
  assert.equal(t.history[t.history.length - 1].seq, before + 1);
});

test("the switch is not written into the toJSON() snapshot", () => {
  const t = toApproved("rpa-9", { requirePayoutAmount: true });
  const snapshot = t.toJSON();
  assert.equal("requirePayoutAmount" in snapshot, false);
  // ...but the budget-style finite switches keep their own convention.
  assert.equal("maxDisputes" in snapshot, false);
});

test("fromJSON() does not restore the switch: advisory again after restore", () => {
  const t = toApproved("rpa-10", { requirePayoutAmount: true });
  const restored = TaskLifecycle.fromJSON(JSON.parse(JSON.stringify(t)));
  restored.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  restored.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(restored.state, "PAID");
});

test("fromHistory() re-attaches the switch via options", () => {
  const t = toApproved("rpa-11");
  const history = JSON.parse(JSON.stringify(t.history));
  const rehydrated = TaskLifecycle.fromHistory("rpa-11", history, {
    requirePayoutAmount: true,
  });
  rehydrated.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  assert.throws(
    () => rehydrated.dispatch("PAYOUT_COMPLETE", { actor: "system" }),
    /payout amount required/,
  );
  // ...and without the option the rehydrated task stays advisory.
  const relaxed = TaskLifecycle.fromHistory("rpa-11", history);
  relaxed.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  relaxed.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  assert.equal(relaxed.state, "PAID");
});
