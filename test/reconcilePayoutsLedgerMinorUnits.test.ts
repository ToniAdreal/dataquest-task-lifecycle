import test from "node:test";
import assert from "node:assert/strict";
import { TaskLifecycle, reconcilePayouts } from "../src/index.js";
import type { DispatchOptions, LedgerPayout } from "../src/index.js";

/** Drive a task from DRAFT to APPROVED (one step before payout). */
function toApproved(id: string): TaskLifecycle {
  const t = new TaskLifecycle(id);
  t.dispatch("PUBLISH", { actor: "researcher" });
  t.dispatch("ACCEPT", { actor: "contributor" });
  t.dispatch("START_CAPTURE", { actor: "contributor" });
  t.dispatch("SUBMIT", { actor: "contributor" });
  t.dispatch("BEGIN_REVIEW", { actor: "reviewer" });
  t.dispatch("APPROVE", { actor: "reviewer" });
  return t;
}

/** Drive a task from DRAFT to PAID, with the given completion options. */
function toPaid(
  id: string,
  completeOpts: DispatchOptions = {},
): TaskLifecycle {
  const t = toApproved(id);
  t.dispatch("REQUEST_PAYOUT", { actor: "contributor" });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system", ...completeOpts });
  assert.equal(t.state, "PAID");
  return t;
}

const SUB_CENT_ERROR =
  "invalid reconcilePayouts: ledger payoutAmount must be a minor-unit amount (at most 2 decimal places)";

test("reconcilePayouts: shared-ref ledger 199.996 against a 200.00 group throws, not matched", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-shared", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-shared", payoutAmount: 100 });
  const ledger: LedgerPayout[] = [
    { payoutRef: "xfer-shared", payoutAmount: 199.996 },
  ];
  // Before the fix the shared-ref path rounded 199.996 to 20000 cents
  // and reported a match for money the ledger never recorded.
  assert.throws(() => reconcilePayouts([a, b], ledger), {
    message: SUB_CENT_ERROR,
  });
});

test("reconcilePayouts: single-task ledger 100.004 against a 100.00 task throws, not amountMismatch", () => {
  const task = toPaid("t-single", {
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  const ledger: LedgerPayout[] = [
    { payoutRef: "xfer-1", payoutAmount: 100.004 },
  ];
  // Before the fix the single-task path compared raw floats and
  // reported an amountMismatch for the same input the shared path
  // would have rounded into a match.
  assert.throws(() => reconcilePayouts([task], ledger), {
    message: SUB_CENT_ERROR,
  });
});

test("reconcilePayouts: ledger 100.005 throws the minor-unit error", () => {
  const task = toPaid("t-100005", {
    payoutRef: "xfer-2",
    payoutAmount: 100,
  });
  assert.throws(
    () =>
      reconcilePayouts([task], [
        { payoutRef: "xfer-2", payoutAmount: 100.005 },
      ]),
    { message: SUB_CENT_ERROR },
  );
});

test("reconcilePayouts: ledger 0.001 throws the minor-unit error", () => {
  const task = toPaid("t-0001", {
    payoutRef: "xfer-3",
    payoutAmount: 0,
  });
  assert.throws(
    () =>
      reconcilePayouts([task], [
        { payoutRef: "xfer-3", payoutAmount: 0.001 },
      ]),
    { message: SUB_CENT_ERROR },
  );
});

test("reconcilePayouts: legal 2-decimal ledger still matches a single task", () => {
  const task = toPaid("t-legal-single", {
    payoutRef: "xfer-4",
    payoutAmount: 100,
  });
  const result = reconcilePayouts([task], [
    { payoutRef: "xfer-4", payoutAmount: 100 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-legal-single"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("reconcilePayouts: legal 2-decimal ledger still matches a shared-ref group", () => {
  const a = toPaid("t-legal-a", {
    payoutRef: "xfer-legal-shared",
    payoutAmount: 100,
  });
  const b = toPaid("t-legal-b", {
    payoutRef: "xfer-legal-shared",
    payoutAmount: 100,
  });
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-legal-shared", payoutAmount: 200 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-legal-a", "t-legal-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
});

test("reconcilePayouts: ledger row without an amount still pairs by reference", () => {
  const task = toPaid("t-no-amount", {
    payoutRef: "xfer-5",
    payoutAmount: 100,
  });
  const result = reconcilePayouts([task], [{ payoutRef: "xfer-5" }]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-no-amount"],
  );
});

test("reconcilePayouts: sub-cent error wins over a duplicate-ref error", () => {
  const task = toPaid("t-order", {
    payoutRef: "xfer-6",
    payoutAmount: 100,
  });
  // The first row is sub-cent AND the ref repeats: the minor-unit
  // check runs before the duplicate check, so its error surfaces.
  assert.throws(
    () =>
      reconcilePayouts([task], [
        { payoutRef: "xfer-6", payoutAmount: 100.005 },
        { payoutRef: "xfer-6", payoutAmount: 100 },
      ]),
    { message: SUB_CENT_ERROR },
  );
});

test("reconcilePayouts: empty ledger behaviour is unchanged", () => {
  const task = toPaid("t-empty", {
    payoutRef: "xfer-7",
    payoutAmount: 100,
  });
  const result = reconcilePayouts([task], []);
  assert.deepEqual(
    result.taskOnly.map((t) => t.id),
    ["t-empty"],
  );
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts: a genuine 2-decimal difference is still an amountMismatch", () => {
  const task = toPaid("t-real-diff", {
    payoutRef: "xfer-8",
    payoutAmount: 100,
  });
  const result = reconcilePayouts([task], [
    { payoutRef: "xfer-8", payoutAmount: 99.99 },
  ]);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].taskAmount, 100);
  assert.equal(result.amountMismatch[0].ledgerAmount, 99.99);
  assert.equal(result.amountMismatch[0].groupAmount, undefined);
  assert.deepEqual(result.matched, []);
});
