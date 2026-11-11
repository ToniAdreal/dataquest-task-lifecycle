import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskLifecycle,
  reconcilePayouts,
  unreconciledPayouts,
} from "../src/index.js";
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

test("reconcilePayouts: all five groups in one mixed batch, in input order", () => {
  const matchedTask = toPaid("t-matched", {
    payoutRef: "xfer-1",
    payoutAmount: 100,
  });
  const taskOnlyTask = toPaid("t-task-only", {
    payoutRef: "xfer-2",
    payoutAmount: 50,
  });
  const mismatchTask = toPaid("t-mismatch", {
    payoutRef: "xfer-3",
    payoutAmount: 90,
  });
  const norefTask = toPaid("t-noref");
  const inFlight = toApproved("t-inflight");
  const ledger: LedgerPayout[] = [
    { payoutRef: "xfer-1", payoutAmount: 100 },
    { payoutRef: "xfer-3", payoutAmount: 100 },
    { payoutRef: "xfer-ledger-only", payoutAmount: 7 },
  ];
  const result = reconcilePayouts(
    [matchedTask, taskOnlyTask, mismatchTask, norefTask, inFlight],
    ledger,
  );
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-matched"],
  );
  assert.deepEqual(
    result.taskOnly.map((t) => t.id),
    ["t-task-only"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-ledger-only"],
  );
  assert.equal(result.amountMismatch.length, 1);
  assert.equal(result.amountMismatch[0].task, mismatchTask);
  assert.equal(result.amountMismatch[0].ledger, ledger[1]);
  assert.equal(result.amountMismatch[0].taskAmount, 90);
  assert.equal(result.amountMismatch[0].ledgerAmount, 100);
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    ["t-noref"],
  );
  // The in-flight task enters no group at all.
  assert.equal(
    [
      ...result.matched,
      ...result.taskOnly,
      ...result.amountMismatch.map((m) => m.task),
      ...result.unreconciled,
    ].includes(inFlight),
    false,
  );
});

test("reconcilePayouts: a request-only reference pairs with nothing", () => {
  const t = toApproved("t-reqonly");
  t.dispatch("REQUEST_PAYOUT", {
    actor: "contributor",
    payoutRef: "batch-2026-1006",
  });
  t.dispatch("PAYOUT_COMPLETE", { actor: "system" });
  const result = reconcilePayouts([t], [
    { payoutRef: "batch-2026-1006", payoutAmount: 10 },
  ]);
  // No PAYOUT_COMPLETE reference, so the task is unreconciled and the
  // ledger row is ledger-only — the request ref is not settlement.
  assert.deepEqual(
    result.unreconciled.map((x) => x.id),
    ["t-reqonly"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((row) => row.payoutRef),
    ["batch-2026-1006"],
  );
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.taskOnly, []);
  assert.deepEqual(result.amountMismatch, []);
});

test("reconcilePayouts: one transfer settling several tasks pairs each of them", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-batch", payoutAmount: 30 });
  const b = toPaid("t-b", { payoutRef: "xfer-batch", payoutAmount: 30 });
  // The ledger row records one transfer, so it records the batch
  // total (60), not one task's amount — the group is compared as a
  // batch (backlog #1054).
  const result = reconcilePayouts([a, b], [
    { payoutRef: "xfer-batch", payoutAmount: 60 },
  ]);
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-a", "t-b"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts: a shared reference is compared as a group, not per task", () => {
  const ok = toPaid("t-ok", { payoutRef: "xfer-batch", payoutAmount: 30 });
  const bad = toPaid("t-bad", {
    payoutRef: "xfer-batch",
    payoutAmount: 31,
  });
  // The batch total is 61; the ledger row records 30 — one task's
  // amount, not the transfer's. Under the old per-task comparison
  // the first task matched and the shortfall hid; under the group
  // comparison both tasks mismatch, each entry carrying the group
  // total that was actually compared (backlog #1054).
  const result = reconcilePayouts([ok, bad], [
    { payoutRef: "xfer-batch", payoutAmount: 30 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.equal(result.amountMismatch.length, 2);
  assert.equal(result.amountMismatch[0].task, ok);
  assert.equal(result.amountMismatch[0].taskAmount, 30);
  assert.equal(result.amountMismatch[0].ledgerAmount, 30);
  assert.equal(result.amountMismatch[0].groupAmount, 61);
  assert.equal(result.amountMismatch[1].task, bad);
  assert.equal(result.amountMismatch[1].taskAmount, 31);
  assert.equal(result.amountMismatch[1].ledgerAmount, 30);
  assert.equal(result.amountMismatch[1].groupAmount, 61);
  assert.deepEqual(result.ledgerOnly, []);
});

test("reconcilePayouts: a task-side amount missing lands in unreconciled, a ledger-side amount missing still pairs on the reference alone", () => {
  const taskNoAmount = toPaid("t-task-no-amount", {
    payoutRef: "xfer-1",
  });
  const ledgerNoAmount = toPaid("t-ledger-no-amount", {
    payoutRef: "xfer-2",
    payoutAmount: 40,
  });
  const result = reconcilePayouts([taskNoAmount, ledgerNoAmount], [
    { payoutRef: "xfer-1", payoutAmount: 40 },
    { payoutRef: "xfer-2" },
  ]);
  // The task side recorded no amount, so it never reaches pairing:
  // it is unreconciled (backlog #1046), and its ledger row stays
  // ledgerOnly — pairing on the reference alone would claim the
  // money was checked when it never was.
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    ["t-task-no-amount"],
  );
  // The ledger side recorded no amount, so there is nothing to
  // compare against — the task pairs on the reference alone.
  assert.deepEqual(
    result.matched.map((t) => t.id),
    ["t-ledger-no-amount"],
  );
  assert.deepEqual(result.amountMismatch, []);
  assert.deepEqual(
    result.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-1"],
  );
});

test("reconcilePayouts: duplicate ledger references fail fast", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  assert.throws(
    () =>
      reconcilePayouts([t], [
        { payoutRef: "xfer-1", payoutAmount: 10 },
        { payoutRef: "xfer-1", payoutAmount: 10 },
      ]),
    /duplicate ledger payoutRef: "xfer-1"/,
  );
});

test("reconcilePayouts: malformed ledger rows fail fast", () => {
  const t = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  const badLedgers: unknown[][] = [
    [{ payoutRef: "", payoutAmount: 10 }],
    [{ payoutRef: 42 }],
    [{ payoutAmount: 10 }],
    [{ payoutRef: "xfer-1", payoutAmount: Number.NaN }],
    [{ payoutRef: "xfer-1", payoutAmount: -5 }],
    [{ payoutRef: "xfer-1", payoutAmount: "10" }],
    [null],
  ];
  for (const ledger of badLedgers) {
    assert.throws(
      () => reconcilePayouts([t], ledger as LedgerPayout[]),
      /invalid reconcilePayouts/,
    );
  }
});

test("reconcilePayouts: empty inputs give five empty groups", () => {
  const result = reconcilePayouts([], []);
  assert.deepEqual(result, {
    matched: [],
    taskOnly: [],
    ledgerOnly: [],
    amountMismatch: [],
    unreconciled: [],
  });
  // A ledger with no tasks is entirely ledger-only.
  const onlyLedger = reconcilePayouts([], [
    { payoutRef: "xfer-1", payoutAmount: 10 },
  ]);
  assert.deepEqual(
    onlyLedger.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-1"],
  );
  assert.deepEqual(onlyLedger.matched, []);
});

test("reconcilePayouts: pure — no dispatch, no state or history change", () => {
  const a = toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 });
  const b = toPaid("t-b", { payoutRef: "xfer-2", payoutAmount: 20 });
  const beforeA = JSON.stringify(a.history);
  const beforeB = JSON.stringify(b.history);
  const ledger = [
    { payoutRef: "xfer-1", payoutAmount: 10 },
    { payoutRef: "xfer-3", payoutAmount: 30 },
  ];
  const result = reconcilePayouts([a, b], ledger);
  assert.equal(a.state, "PAID");
  assert.equal(b.state, "PAID");
  assert.equal(JSON.stringify(a.history), beforeA);
  assert.equal(JSON.stringify(b.history), beforeB);
  // Groups hold the same objects, not copies.
  assert.equal(result.matched[0], a);
  assert.equal(result.taskOnly[0], b);
  assert.equal(result.ledgerOnly[0], ledger[1]);
  // Re-running gives the same grouping.
  const again = reconcilePayouts([a, b], ledger);
  assert.deepEqual(
    again.matched.map((t) => t.id),
    result.matched.map((t) => t.id),
  );
});

test("reconcilePayouts: matching is exact and case-sensitive, like the stored reference", () => {
  const t = toPaid("t-a", { payoutRef: "Xfer-88f2", payoutAmount: 10 });
  const result = reconcilePayouts([t], [
    { payoutRef: "xfer-88f2", payoutAmount: 10 },
  ]);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(
    result.taskOnly.map((x) => x.id),
    ["t-a"],
  );
  assert.deepEqual(
    result.ledgerOnly.map((row) => row.payoutRef),
    ["xfer-88f2"],
  );
});

test("reconcilePayouts: unreconciled group agrees with unreconciledPayouts", () => {
  const batch = [
    toPaid("t-a", { payoutRef: "xfer-1", payoutAmount: 10 }),
    toPaid("t-b"),
    toPaid("t-c", { payoutRef: "xfer-9", payoutAmount: 5 }),
    toApproved("t-d"),
  ];
  const result = reconcilePayouts(batch, [
    { payoutRef: "xfer-1", payoutAmount: 10 },
  ]);
  assert.deepEqual(
    result.unreconciled.map((t) => t.id),
    unreconciledPayouts(batch).map((t) => t.id),
  );
});
