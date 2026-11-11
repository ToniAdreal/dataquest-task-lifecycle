import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  reconcilePayouts,
  totalPaidOut,
} from "../src/index.js";
import type { DispatchOptions, LedgerPayout } from "../src/index.js";

/**
 * Shared-`payoutRef` batch comparison (backlog #1054): a ledger row
 * records one transfer, so when several PAID tasks share one
 * reference the row's amount is checked against the SUM of their
 * settled amounts — not against each task's amount in turn. The old
 * per-task comparison was wrong in both directions: a row recording
 * the batch total flagged every task as mismatched (false positive),
 * while a row recording one task's amount matched every task and
 * hid the money the ledger never recorded (a double payment the
 * library failed to catch).
 *
 * Rules under test:
 *  - a shared ref compares its group total (integer minor units,
 *    the totalPaidOut cents convention) against the ledger row;
 *    equal → the whole group matched, unequal → the whole group in
 *    amountMismatch, one entry per task, each carrying the group
 *    total as `groupAmount`
 *  - a single-task ref keeps the exact per-task comparison and
 *    carries no `groupAmount`
 *  - a group member with no recorded amount never reaches pairing
 *    (unreconciled) and contributes nothing to the sum
 *  - a ledger row with no amount still pairs the whole group on
 *    the reference alone
 *  - every group keeps input order, even when refs interleave
 */

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

test("reconcilePayouts shared ref: ledger batch total matches the whole group", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 200 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts shared ref: ledger single-task amount catches the double payment", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  // The ledger paid 100 for a transfer that settled 200: the old
  // per-task comparison matched both tasks and hid the shortfall.
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 100 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 2);
  assert.equal(result.amountMismatch[0].task, a);
  assert.equal(result.amountMismatch[0].taskAmount, 100);
  assert.equal(result.amountMismatch[0].ledgerAmount, 100);
  assert.equal(result.amountMismatch[0].groupAmount, 200);
  assert.equal(result.amountMismatch[1].task, b);
  assert.equal(result.amountMismatch[1].taskAmount, 100);
  assert.equal(result.amountMismatch[1].ledgerAmount, 100);
  assert.equal(result.amountMismatch[1].groupAmount, 200);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts shared ref: ledger batch total short by one cent mismatches the whole group", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 199.99 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(
    result.amountMismatch.map((m) => m.task.id),
    ["t-a", "t-b"],
  );
  assert.equal(result.amountMismatch[0].groupAmount, 200);
  assert.equal(result.amountMismatch[0].ledgerAmount, 199.99);
});

test("reconcilePayouts single ref: old per-task behaviour is unchanged", () => {
  const matched = toPaid("t-matched", {
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  const mismatched = toPaid("t-mismatched", {
    payoutRef: "xfer-2",
    payoutAmount: 90,
  });
  const result = reconcilePayouts([matched, mismatched], [
    { payoutRef: "xfer-1", payoutAmount: 100 },
    { payoutRef: "xfer-2", payoutAmount: 100 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-matched"],
  );
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].task, mismatched);
  assert.equal(result.amountMismatch[0].taskAmount, 90);
  assert.equal(result.amountMismatch[0].ledgerAmount, 100);
  // A single-task mismatch compares the task's own amount: there is
  // no group total to report.
  assert.equal(result.amountMismatch[0].groupAmount, undefined);
});

test("reconcilePayouts shared ref: a member with no amount is unreconciled and adds nothing to the sum", () => {
  const withAmount = toPaid("t-with-amount", {
    payoutRef: "xfer-batch",
    payoutAmount: 100,
  });
  const noAmount = toPaid("t-no-amount", { payoutRef: "xfer-batch" });
  const result = reconcilePayouts([withAmount, noAmount], [
    { payoutRef: "xfer-batch", payoutAmount: 100 },
  ]);
  // Only one task reaches pairing, so it is compared singly: 100
  // against 100 matches, and the amount-less task never enters the
  // sum (had it counted as 0 the result would be the same here —
  // the next test separates the two readings).
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-with-amount"],
  );
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    ["t-no-amount"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts shared ref: the amount-less member does not stretch the single comparison", () => {
  const withAmount = toPaid("t-with-amount", {
    payoutRef: "xfer-batch",
    payoutAmount: 100,
  });
  const noAmount = toPaid("t-no-amount", { payoutRef: "xfer-batch" });
  const result = reconcilePayouts([withAmount, noAmount], [
    { payoutRef: "xfer-batch", payoutAmount: 200 },
  ]);
  // The ledger row records 200 — the would-be batch total if the
  // amount-less task had settled 100 — but it settled nothing
  // recorded, so the only pairing task compares singly: 100 against
  // 200 mismatches, with no group total attached.
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].task, withAmount);
  assert.equal(result.amountMismatch[0].taskAmount, 100);
  assert.equal(result.amountMismatch[0].ledgerAmount, 200);
  assert.equal(result.amountMismatch[0].groupAmount, undefined);
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    ["t-no-amount"],
  );
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts shared ref: ledger row with no amount pairs the whole group on the reference alone", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const result = reconcilePayouts([a, b], [{ payoutRef: "xfer-batch" }]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts shared ref: cent rounding — 0.1 + 0.2 compares as 0.30", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 0.1 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 0.2 });
  // Binary floats would sum to 0.30000000000000004; in minor units
  // 10 + 20 = 30, exactly the ledger's 0.30.
  const matched = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 0.3 },
  ]);
  assert.deepEqual(
    matched.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(matched.amountMismatch, []);
  const mismatched = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 0.31 },
  ]);
  assert.deepEqual(mismatched.matched, []);
  assert.equal(mismatched.amountMismatch.length, 2);
  assert.equal(mismatched.amountMismatch[0].groupAmount, 0.3);
  assert.equal(mismatched.amountMismatch[0].ledgerAmount, 0.31);
});

test("reconcilePayouts shared ref: group total agrees with totalPaidOut", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  // The group total is the same sum totalPaidOut computes over the
  // same tasks, in the same minor-unit convention.
  assert.equal(totalPaidOut([a, b]), 200);
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 150 },
  ]);
  assert.equal(result.amountMismatch[0].groupAmount, totalPaidOut([a, b]));
  assert.equal(result.amountMismatch[1].groupAmount, totalPaidOut([a, b]));
});

test("reconcilePayouts shared ref: three-task group compares its total", () => {
  const tasks = [50, 50, 50].map((amount, i) =>
    toPaid(`t-${i + 1}`, {
      payoutRef: "xfer-batch",
      payoutAmount: amount,
    }),
  );
  const matched = reconcilePayouts(tasks, [
    { payoutRef: "xfer-batch", payoutAmount: 150 },
  ]);
  assert.deepEqual(
    matched.matched.map((t) => t.id),
    ["t-1", "t-2", "t-3"],
  );
  const mismatched = reconcilePayouts(tasks, [
    { payoutRef: "xfer-batch", payoutAmount: 100 },
  ]);
  assert.deepEqual(mismatched.matched, []);
  assert.deepEqual(
    mismatched.amountMismatch.map((m) => m.task.id),
    ["t-1", "t-2", "t-3"],
  );
  assert.equal(mismatched.amountMismatch[0].groupAmount, 150);
});

test("reconcilePayouts shared ref: input order is kept across interleaved refs", () => {
  const firstShared = toPaid("first-shared", {
    payoutRef: "xfer-shared",
    payoutAmount: 30,
  });
  const onlyA = toPaid("only-a", { payoutRef: "xfer-a", payoutAmount: 100 });
  const secondShared = toPaid("second-shared", {
    payoutRef: "xfer-shared",
    payoutAmount: 30,
  });
  const onlyB = toPaid("only-b", { payoutRef: "xfer-b", payoutAmount: 50 });
  const ledger: LedgerPayout[] = [
    { payoutRef: "xfer-shared", payoutAmount: 60 },
    { payoutRef: "xfer-a", payoutAmount: 100 },
    { payoutRef: "xfer-b", payoutAmount: 50 },
  ];
  const result = reconcilePayouts(
    [firstShared, onlyA, secondShared, onlyB],
    ledger,
  );
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["first-shared", "only-a", "second-shared", "only-b"],
  );
  const mismatched = reconcilePayouts(
    [firstShared, onlyA, secondShared, onlyB],
    [
      { payoutRef: "xfer-shared", payoutAmount: 30 },
      { payoutRef: "xfer-a", payoutAmount: 100 },
      { payoutRef: "xfer-b", payoutAmount: 50 },
    ],
  );
  assert.deepEqual(
    mismatched.matched.map((t) => t.id),
    ["only-a", "only-b"],
  );
  assert.deepEqual(
    mismatched.amountMismatch.map((m) => m.task.id),
    ["first-shared", "second-shared"],
  );
  assert.equal(mismatched.amountMismatch[0].groupAmount, 60);
});

test("reconcilePayouts shared ref: empty batch and ledger-only ref are unchanged", () => {
  const result = reconcilePayouts([], []);
  assert.deepEqual(result, {
    matched: [],
    taskOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    unreconciled: [],
  });
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 100 });
  const onlyLedger = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 200 },
    { payoutRef: "xfer-other", payoutAmount: 7 },
  ]);
  assert.deepEqual(
    onlyLedger.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(
    onlyLedger.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-other"],
  );
});
