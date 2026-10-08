import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, totalPaidOut } from "../src/index.js";

/**
 * `payoutAmount` (backlog #105): the money half of settlement
 * reconciliation.
 *
 * `payoutRef` (an opaque string) answers "was there a transfer id";
 * `payoutAmount` answers "how much actually settled". Rules under test:
 *  - dispatch-time validation: non-finite / negative / non-number values
 *    throw `invalid dispatch options: …` before anything mutates
 *  - a valid amount is recorded on the audit entry, survives
 *    toJSON()/fromJSON() round-trips, and commits into the hash chain
 *  - parseHistory (via fromJSON) rejects malformed payoutAmount values
 *    in untrusted logs
 *  - totalPaidOut(tasks) sums per-PAID-task amounts, rounds the total to
 *    cents, counts unrecorded amounts as 0, and ignores non-PAID tasks
 */

/** Drive a task from DRAFT to the payout request step. */
function toPayoutRequested(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  return t;
}

const ILLEGAL_AMOUNTS: unknown[] = [
  -0.01,
  -100,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "10630.50",
  null,
  {},
];

test("illegal payoutAmount values throw up front and leave no trace", () => {
  for (const amount of ILLEGAL_AMOUNTS) {
    const t = toPayoutRequested(`bad-amount-${String(amount)}`);
    const before = t.history.length;
    assert.throws(
      () =>
        t.dispatch("PAYOUT_COMPLETE", {
          actor: "system",
          payoutAmount: amount as number,
        }),
      /invalid dispatch options: payoutAmount must be a non-negative finite number/,
      `expected ${String(amount)} to be rejected`,
    );
    // Fail-fast: no entry appended, state untouched, retry possible.
    assert.equal(t.history.length, before);
    assert.equal(t.state, "PAYOUT_PENDING");
    t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 1 });
    assert.equal(t.state, "PAID");
  }
});

test("zero is a legal amount (free work settles with a receipt)", () => {
  const t = toPayoutRequested("free-task");
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 0 });
  assert.equal(t.history[t.history.length - 1].payoutAmount, 0);
});

test("valid amount lands verbatim on the entry and in the hash chain", () => {
  const t = toPayoutRequested("paid-task");
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-123",
    payoutAmount: 10098.5,
  });
  const entry = t.history[t.history.length - 1];
  assert.equal(entry.payoutAmount, 10098.5);
  // The amount is part of the canonical hash input: rewriting it breaks
  // the chain (parseHistory rejects the tampered rehydration).
  const tampered = t.toJSON();
  tampered.history[tampered.history.length - 1].payoutAmount = 999999;
  assert.throws(
    () => TaskLifecycle.fromJSON(tampered),
    /history hash chain is broken/,
  );
});

test("amount survives toJSON()/fromJSON() round-trips", () => {
  const t = toPayoutRequested("round-trip");
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutRef: "xfer-456",
    payoutAmount: 531.5,
  });
  const revived = TaskLifecycle.fromJSON(t.toJSON());
  assert.deepEqual(revived.toJSON().history, t.toJSON().history);
  assert.equal(revived.history[revived.history.length - 1].payoutAmount, 531.5);
});

test("fromJSON rejects malformed payoutAmount in untrusted logs", () => {
  const t = toPayoutRequested("untrusted");
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 10 });
  for (const bad of [-5, Number.NaN, "10", null]) {
    const snapshot = t.toJSON();
    snapshot.history[snapshot.history.length - 1].payoutAmount =
      bad as unknown as number;
    assert.throws(
      () => TaskLifecycle.fromJSON(snapshot),
      /payoutAmount must be a non-negative finite number/,
      `expected ${String(bad)} to be rejected`,
    );
  }
});

test("totalPaidOut sums PAID tasks and rounds the total to cents", () => {
  const a = toPayoutRequested("a");
  a.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 10098.5 });
  const b = toPayoutRequested("b");
  b.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 531.5 });
  const c = toPayoutRequested("c");
  c.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 0.1 });
  const d = toPayoutRequested("d");
  d.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 0.2 });
  assert.equal(totalPaidOut([a, b, c, d]), 10630.3);
});

test("totalPaidOut counts unrecorded amounts as 0 and ignores non-PAID tasks", () => {
  const withAmount = toPayoutRequested("with-amount");
  withAmount.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 100,
  });
  const noAmount = toPayoutRequested("no-amount");
  noAmount.dispatch("PAYOUT_COMPLETE", { actor: "system" }); // legal, no amount
  const inFlight = toPayoutRequested("in-flight"); // not PAID
  const abandoned = new TaskLifecycle("abandoned");
  abandoned.dispatch("PUBLISH", { actor: "researcher" });
  abandoned.dispatch("ACCEPT", { actor: "contributor" });
  abandoned.dispatch("ABANDON", { actor: "contributor" });
  assert.equal(totalPaidOut([withAmount, noAmount, inFlight, abandoned]), 100);
  assert.equal(totalPaidOut([]), 0);
});

test("totalPaidOut is pure and works on rehydrated tasks", () => {
  const t = toPayoutRequested("pure");
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", payoutAmount: 42.25 });
  const before = JSON.stringify(t.toJSON());
  const revived = TaskLifecycle.fromJSON(t.toJSON());
  assert.equal(totalPaidOut([revived]), 42.25);
  assert.equal(JSON.stringify(t.toJSON()), before);
  assert.equal(t.state, "PAID");
});

test("totalPaidOut reads the PAYOUT_COMPLETE entry, not other entries", () => {
  const t = toPayoutRequested("ref-on-request");
  t.dispatch("PAYOUT_COMPLETE", {
    actor: "system",
    payoutAmount: 999,
    payoutRef: "xfer-999",
  });
  // An amount on a non-completion entry is stored as generic audit
  // metadata but never counted toward the payout total.
  const t2 = new TaskLifecycle("amount-on-note");
  t2.dispatch("PUBLISH", { actor: "researcher", payoutAmount: 12345 });
  assert.equal(t2.history[0].payoutAmount, 12345);
  assert.equal(totalPaidOut([t, t2]), 999);
});
